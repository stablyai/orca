import { describe, expect, it, vi } from 'vitest'
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../../shared/remote-runtime/control/remote-runtime-shared-control-types'
import { reconnectSharedControlIfIdle } from './runtime-environment-shared-control-reconnect'

type State = RemoteRuntimeSharedConnectionDiagnostics['state']

function connection(state: State | null) {
  return {
    getDiagnostics: () => (state === null ? null : { state }),
    reconnectNow: vi.fn()
  }
}

describe('reconnectSharedControlIfIdle', () => {
  it.each<State>(['awaiting_ready', 'awaiting_authenticated', 'ready'])(
    'leaves a socket that is %s alone',
    (state) => {
      const socket = connection(state)
      reconnectSharedControlIfIdle(socket)
      expect(socket.reconnectNow).not.toHaveBeenCalled()
    }
  )

  it.each<State | null>(['closed', 'reconnecting', null])(
    'reconnects when the socket is %s',
    (state) => {
      const socket = connection(state)
      reconnectSharedControlIfIdle(socket)
      expect(socket.reconnectNow).toHaveBeenCalledTimes(1)
    }
  )

  it('does nothing without a connection', () => {
    expect(() => reconnectSharedControlIfIdle(undefined)).not.toThrow()
  })
})
