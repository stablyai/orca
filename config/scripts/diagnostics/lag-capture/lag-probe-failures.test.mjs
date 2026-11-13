import assert from 'node:assert/strict'
import { test } from 'vitest'
import { runInNewContext } from 'node:vm'
import { connectOrcaMainInspector } from './orca-main-inspector-connection.mjs'

test('socket closure rejects outstanding and subsequent requests', async () => {
  let socket
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
    setTimeout() {
      return 1
    },
    clearTimeout() {}
  })
  const connection = await connect(42)
  const first = connection.send('Profiler.start')
  const second = connection.send('Profiler.stop')
  socket.close()
  await assert.rejects(first, /Inspector socket closed/)
  await assert.rejects(second, /Inspector socket closed/)
  await assert.rejects(connection.send('Profiler.enable'), /not open/)
})
