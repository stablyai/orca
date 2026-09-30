import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import { closeRelayWebSocket } from './relay-websocket-close.js'

class FakeSocket extends EventEmitter {
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readyState = this.OPEN
  readonly close = vi.fn(() => {
    this.readyState = this.CLOSING
  })
  readonly terminate = vi.fn(() => {
    this.readyState = this.CLOSED
    this.emit('close')
  })
}

describe('relay WebSocket close', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('terminates a peer that does not complete the close handshake', () => {
    const socket = new FakeSocket()
    closeRelayWebSocket(socket as unknown as WebSocket, 4408, 'relay draining')

    expect(socket.close).toHaveBeenCalledWith(4408, 'relay draining')
    vi.advanceTimersByTime(999)
    expect(socket.terminate).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(socket.terminate).toHaveBeenCalledOnce()
  })

  it('cancels forced termination after the peer closes', () => {
    const socket = new FakeSocket()
    closeRelayWebSocket(socket as unknown as WebSocket, 4408, 'relay draining')
    socket.readyState = socket.CLOSED
    socket.emit('close')
    vi.runAllTimers()

    expect(socket.terminate).not.toHaveBeenCalled()
  })
})
