import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { RelayLoadControlPeer } from './relay-load-control-peer.mjs'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function trackTimers(context) {
  const timers = new Set()
  context.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const timer = { callback, delay }
    timers.add(timer)
    return timer
  })
  context.mock.method(globalThis, 'clearTimeout', (timer) => timers.delete(timer))
  return {
    timers,
    fire(timer) {
      assert.equal(timers.delete(timer), true)
      timer.callback()
    }
  }
}

function attachSocket(peer) {
  const socket = new EventEmitter()
  socket.OPEN = 1
  socket.CLOSING = 2
  socket.CLOSED = 3
  socket.readyState = socket.OPEN
  socket.send = () => undefined
  socket.close = () => {
    socket.readyState = socket.CLOSED
    socket.emit('close', 1000)
  }
  socket.once('close', (code) => peer.onClose(socket, code))
  peer.socket = socket
  return socket
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

for (const outcome of ['resolve', 'reject']) {
  test(`an old refresh cannot add a timer after reconnect (${outcome})`, async (context) => {
    const clock = trackTimers(context)
    const peer = new RelayLoadControlPeer(0, {}, () => undefined)
    context.after(() => peer.shutdown())
    let socket = attachSocket(peer)
    peer.scheduleRefresh(1)

    for (let cycle = 0; cycle < 10; cycle++) {
      const token = deferred()
      peer.relayToken = () => token.promise
      clock.fire(peer.refreshTimer)
      assert.equal(peer.inFlight.size, 1)
      socket.close()
      socket = attachSocket(peer)
      peer.scheduleRefresh(1)
      token[outcome](outcome === 'resolve' ? 'relay-token' : new Error('token failed'))
      await flush()

      assert.equal(clock.timers.size, 1, `refresh timers after reconnect ${cycle + 1}`)
      assert.equal(peer.inFlight.size, 0)
    }

    peer.relayToken = async () => 'current-token'
    clock.fire(peer.refreshTimer)
    await flush()
    assert.equal(clock.timers.size, 1)
    assert.equal(peer.refreshTimer.delay, peer.phase.refreshIntervalMs)

    await peer.shutdown()
    assert.equal(clock.timers.size, 0)
  })
}

test('a refresh that finishes after disconnect stays stopped until reconnect', async (context) => {
  const clock = trackTimers(context)
  const peer = new RelayLoadControlPeer(0, {}, () => undefined)
  context.after(() => peer.shutdown())
  const socket = attachSocket(peer)
  const token = deferred()
  peer.relayToken = () => token.promise
  peer.scheduleRefresh(1)
  clock.fire(peer.refreshTimer)
  socket.close()
  token.resolve('old-token')
  await flush()
  assert.equal(clock.timers.size, 0)
  assert.equal(peer.refreshTimer, null)

  attachSocket(peer)
  peer.scheduleRefresh(1)
  assert.equal(clock.timers.size, 1)
  await peer.shutdown()
  assert.equal(clock.timers.size, 0)
})
