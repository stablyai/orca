import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type WebSocket from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { DeviceRegistry } from './device-registry'
import type { RpcDispatchStreamingOptions } from './rpc/dispatcher-stream-options'
import { WS_CLOSE_FLUSH_BOUND_MS } from './rpc/ws-bounded-close'

class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1
  readonly CLOSED = 3
  readyState = this.OPEN
  close = vi.fn()
  terminate = vi.fn()
}

// Why: ws queues a close frame behind buffered output, so the stream that lost a frame to
// backpressure must not wait for that backlog to drain before the client learns (#20802).
async function captureCloseConnection(ws: FakeWebSocket) {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-close-'))
  const server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath,
    enableWebSocket: false
  })
  server['deviceRegistry'] = new DeviceRegistry(userDataPath)
  const device = server['deviceRegistry']!.addDevice('desktop', 'runtime')
  let captured: RpcDispatchStreamingOptions | undefined
  vi.spyOn(server['dispatcher'], 'dispatchStreaming').mockImplementation(
    async (_request, _reply, options) => {
      captured = options
    }
  )
  await server['handleWebSocketMessage'](
    JSON.stringify({ id: 'req_mux', method: 'terminal.multiplex', deviceToken: device.token }),
    () => {},
    () => false,
    undefined,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatch path only reads events, readyState, close and terminate, all of which the fake implements.
    ws as unknown as WebSocket
  )
  await server.stop()
  return captured?.closeConnection
}

describe('WebSocket closeConnection', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('terminates the socket when the close handshake does not finish within the bound', async () => {
    const ws = new FakeWebSocket()
    const closeConnection = await captureCloseConnection(ws)
    vi.useFakeTimers()

    closeConnection?.(1013, 'Terminal stream frame dropped under backpressure')

    expect(ws.close).toHaveBeenCalledWith(1013, 'Terminal stream frame dropped under backpressure')
    expect(ws.terminate).not.toHaveBeenCalled()
    vi.advanceTimersByTime(WS_CLOSE_FLUSH_BOUND_MS)
    expect(ws.terminate).toHaveBeenCalledOnce()
  })

  it('leaves the socket alone once the close handshake completes', async () => {
    const ws = new FakeWebSocket()
    const closeConnection = await captureCloseConnection(ws)
    vi.useFakeTimers()

    closeConnection?.(1013, 'Terminal stream frame dropped under backpressure')
    ws.readyState = ws.CLOSED
    ws.emit('close')
    vi.advanceTimersByTime(WS_CLOSE_FLUSH_BOUND_MS)

    expect(ws.terminate).not.toHaveBeenCalled()
  })
})
