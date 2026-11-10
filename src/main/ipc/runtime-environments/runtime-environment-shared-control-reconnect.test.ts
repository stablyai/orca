import { describe, expect, it, vi } from 'vitest'
import { reconnectSharedControlIfIdle } from './runtime-environment-shared-control-reconnect'

function connection(state: string | null) {
  return {
    getDiagnostics: () => (state === null ? null : ({ state } as never)),
    reconnectNow: vi.fn()
  }
}

describe('reconnectSharedControlIfIdle', () => {
  it.each(['awaiting_ready', 'awaiting_authenticated', 'ready'])(
    'leaves a socket that is %s alone',
    (state) => {
      const socket = connection(state)
      reconnectSharedControlIfIdle(socket)
      expect(socket.reconnectNow).not.toHaveBeenCalled()
    }
  )

  it.each(['closed', 'reconnecting', null])('reconnects when the socket is %s', (state) => {
    const socket = connection(state)
    reconnectSharedControlIfIdle(socket)
    expect(socket.reconnectNow).toHaveBeenCalledTimes(1)
  })

  it('does nothing without a connection', () => {
    expect(() => reconnectSharedControlIfIdle(undefined)).not.toThrow()
  })
})
