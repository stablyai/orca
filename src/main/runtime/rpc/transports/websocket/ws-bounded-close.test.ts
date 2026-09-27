import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WS_CLOSE_FLUSH_BOUND_MS, closeWebSocketWithinFlushBound } from './ws-bounded-close'

class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1
  readonly CLOSED = 3
  readyState = this.OPEN
  close = vi.fn()
  terminate = vi.fn()
}

function asWebSocket(ws: FakeWebSocket): WebSocket {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bounded close only reads events, readyState, close and terminate, all of which the fake implements.
  return ws as unknown as WebSocket
}

// ws queues a close frame behind buffered output, so a stream that lost a frame to backpressure
// must not wait for that backlog to drain before the client learns (#20802).
describe('closeWebSocketWithinFlushBound', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('terminates the socket when the close handshake does not finish within the bound', () => {
    vi.useFakeTimers()
    const ws = new FakeWebSocket()

    closeWebSocketWithinFlushBound(asWebSocket(ws), 1013, 'dropped')

    expect(ws.close).toHaveBeenCalledWith(1013, 'dropped')
    expect(ws.terminate).not.toHaveBeenCalled()
    vi.advanceTimersByTime(WS_CLOSE_FLUSH_BOUND_MS)
    expect(ws.terminate).toHaveBeenCalledOnce()
  })

  it('leaves the socket alone once the close handshake completes', () => {
    vi.useFakeTimers()
    const ws = new FakeWebSocket()

    closeWebSocketWithinFlushBound(asWebSocket(ws), 1013, 'dropped')
    ws.readyState = ws.CLOSED
    ws.emit('close')
    vi.advanceTimersByTime(WS_CLOSE_FLUSH_BOUND_MS)

    expect(ws.terminate).not.toHaveBeenCalled()
  })

  it('does nothing for a socket that is already closed', () => {
    const ws = new FakeWebSocket()
    ws.readyState = ws.CLOSED

    closeWebSocketWithinFlushBound(asWebSocket(ws), 1013, 'dropped')

    expect(ws.close).not.toHaveBeenCalled()
  })
})
