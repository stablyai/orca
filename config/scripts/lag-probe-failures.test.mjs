import assert from 'node:assert/strict'
import { test } from 'vitest'
import { runInNewContext } from 'node:vm'
import { installRendererIpcProbe } from './main-blocking-probe.mjs'
import { connectOrcaMainInspector } from './orca-main-inspector-connection.mjs'

test('IPC polling records a rejection and permits the next poll', async () => {
  let poll
  let calls = 0
  const window = {
    api: {
      app: {
        getIdentity: async () => {
          if (++calls === 1) {
            throw new Error('IPC disconnected')
          }
        }
      }
    }
  }
  runInNewContext(`(${String(installRendererIpcProbe)})()`, {
    window,
    performance,
    Date,
    document: { addEventListener() {}, removeEventListener() {} },
    setInterval(callback) {
      poll = callback
      return 1
    },
    clearInterval() {}
  })
  await poll()
  await poll()
  const { requests } = window.__orcaIpcTimingProbe.stop()
  assert.equal(requests.length, 2)
  assert.match(requests[0].failed, /IPC disconnected/)
  assert.equal(requests[1].failed, undefined)
})

test('socket closure rejects outstanding and subsequent requests without timeout timers', async () => {
  let socket
  const timers = new Set()
  class FakeSocket {
    static OPEN = 1
    readyState = 1
    constructor() {
      socket = this
      queueMicrotask(() => this.onopen())
    }
    send(payload) {
      const { id, params } = JSON.parse(payload)
      if (params.expression === 'process.pid') {
        queueMicrotask(() =>
          this.onmessage({ data: JSON.stringify({ id, result: { result: { value: 42 } } }) })
        )
      }
    }
    close() {
      this.readyState = 3
      this.onclose()
    }
  }
  const connect = runInNewContext(`(${String(connectOrcaMainInspector)})`, {
    fetch: async () => ({ json: async () => [{ webSocketDebuggerUrl: 'ws://fixture' }] }),
    WebSocket: FakeSocket,
    setTimeout(callback) {
      timers.add(callback)
      return callback
    },
    clearTimeout(timer) {
      timers.delete(timer)
    }
  })
  const connection = await connect(42)
  const first = connection.send('Profiler.start')
  const second = connection.send('Profiler.stop')
  socket.close()
  await assert.rejects(first, /Inspector socket closed/)
  await assert.rejects(second, /Inspector socket closed/)
  await assert.rejects(connection.send('Profiler.enable'), /not open/)
  assert.equal(timers.size, 0)
})
