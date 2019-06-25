'use strict'

const BFX = require('bitfinex-api-node')
const { Order } = require('bfx-api-node-models')

const async = require('async')
const BN = require('bignumber.js')

const util = require('util')

const conf = require('./config/conf.json')

const symbol = 'tETHF0:USTF0'
const users = ['user1', 'user2']
const amountOfTrades = 5

const defaults = {
  ws: {
    autoReconnect: true,
    seqAudit: true,
    packetWDDelay: 10 * 1000
  }
}

const connections = users.map((u, i) => {
  const opts = Object.assign({}, defaults, conf.common, conf[u])
  const optsHttp = Object.assign({}, defaults, conf.common, conf[u + '_http'])

  const bfx = new BFX(opts)
  const ws = bfx.ws(2)

  const bfxHttp = new BFX(optsHttp)
  const rest = bfxHttp.rest(2)

  ws.on('error', (err) => {
    console.error(err)
  })

  ws.on('message', (data) => {
    // console.log(u, data)
  })

  return { rest, ws, id: i + 1 }
})

async.auto({
  connect: (next) => {
    async.map(connections, ({ ws }, cb) => {
      ws.on('open', () => {
        ws.auth()
      })

      ws.once('auth', () => { cb() })
      ws.open()

      return
      ws.onOrderSnapshot({}, (snapshot) => {
        const cancelOrders = util.callbackify(ws.cancelOrders).bind(ws)
        cancelOrders(snapshot, cb)
      }, (err) => {
        console.log('ERRR', err)
        // cleanup listener
        ws.onOrderSnapshot({}, () => {})
        cb()
      })
    }, next)
  },

  positions: ['connect', (args, next) => {
    async.map(connections, (conn, cb) => {
      conn.rest.positions((err, data) => {
        if (err) return cb(err)

        conn.position = data[0]
        if (!conn.position || !conn.position[2]) {
          conn.position = [ symbol, '', 0, 0 ]
        }

        cb(null, data)
      })
    }, next)
  }],

  flags: ['positions', (args, next) => {
    async.map(connections, ({ ws }, cb) => {
      const enableFlag = util.callbackify(ws.enableFlag).bind(ws)
      // decimalstrings
      enableFlag(8, cb)
    }, next)
  }],

  ticker: ['flags', (args, next) => {
    const ws = connections[0].ws

    ws.onTicker({ symbol: symbol }, (ticker) => {
      ws.unsubscribeTicker(symbol)
      next(null, ticker)
    })

    ws.subscribeTicker(symbol)
  }],

  trade: ['ticker', (args, next) => {
    const lastPrice = args.ticker[6]
    const trades = getTrades(lastPrice)

    async.mapSeries(trades, (trade, cb) => {
      const mod = (id) => { return id % 2 === 0 }

      sendMatchingTrades(connections, trade, mod, () => {
        return cb(null)
      })

    }, (err) => {
      if (err) return next(err)

      setTimeout(() => {
        next(null, trades)
      }, 100)
    })
  }],

  checkTrades: ['trade', (args, next) => {
    async.mapSeries(connections, (conn, cb) => {
      conn.rest.positions((err, data) => {
        if (err) return cb(err)

        cb(null, data[0])
      })
    }, (err, newPos) => {
      if (err) return next(err)

      const res = newPos.map((pos, i) => {
        const [ , , amount ] = pos
        return amount
      })

      const traded = args.trade.reduce((acc, el) => {
        acc.amount = acc.amount.plus(el[0])
        return acc
      }, { amount: new BN(0) })

      let error = false
      connections.forEach((el, i) => {
        const [ ,, oldAmount ] = el.position

        const resB = new BN(res[i] + '')
        const oldAmountB = new BN(oldAmount + '')

        let exp
        if (i % 2 === 0) {
          exp = resB.minus(oldAmountB).toString()
        } else {
          exp = oldAmountB.minus(resB).toString()
        }

        if (exp !== traded.amount.toString()) {
          error = true
        }

        if (error) {
          console.error("------- Error ------")
          console.log(exp, '!==', traded.amount.toString())
          console.error('trades:')
          printTrades(args.trade)
          console.error(`old pos user ${i}:`)
          console.error(el.position)

          console.error('new pos:')
          console.error(newPos)
          console.error('-------')
        }
      })

      if (error) return next(new Error('uneven result'))

      next(null, {})
    })
  }]
}, (err) => {
  if (err) console.error('ERR', err)

  console.log('done!')
})

function sendMatchingTrades (connections, trade, mod, next) {
  const [ amount, price ] = trade

  async.mapSeries(connections, ({ ws, id }, cb) => {
    const amt = mod(id) ? amount.toString() : amount.multipliedBy('-1').toString()

    // console.log("sending trade", amt, price.toString())
    const data = {
      cid: Date.now(),
      symbol: symbol,
      price: price.toString(),
      amount: amt,
      type: Order.type.LIMIT
    }

    const o = new Order(data, ws)

    o.registerListeners()

    const submit = util.callbackify(o.submit).bind(o)

    const listener = (err, data) => {
      console.log(data.status, data.id)

      if (/EXECUTED/.test(data.status) || /FILLED/.test(data.status)) {
        o.removeListener('update', listener)
        o.removeListeners()
      }
    }

    o.on('update', listener)

    submit(() => {})
    cb()
  }, () => {
    setTimeout(() => {
      next()
    }, 50)
  })
}

function getTrades (last) {
  const trades = []

  for (let i = 0; i < amountOfTrades; i++) {
    const price = (last + (Math.random() * (0.2 - 0.1) + 0.1)).toFixed(4)
    const amount = (Math.random() * (0.4 - 0.1) + 0.1).toFixed(4)
    trades[i] = [ new BN(amount), new BN(price) ]
  }

  return trades
}

function printTrades (trades) {
  trades.forEach((el, i) => {
    const [amount, price] = el
    console.log(i, amount.toString(), '@', price.toString())
  })
}
