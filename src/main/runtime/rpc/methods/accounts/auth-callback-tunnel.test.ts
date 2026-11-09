import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import {
  AUTH_CALLBACK_FORWARD_MAX_BYTES as AUTH_CALLBACK_TUNNEL_MAX_BYTES,
  AUTH_CALLBACK_FORWARD_MAX_STREAMS as AUTH_CALLBACK_TUNNEL_MAX_STREAMS
} from '../../../../../shared/auth-callback-forward'
import { createAuthCallbackDialer } from './auth-callback-tunnel'

function fakeSocket(): Socket {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; only the members the dialer calls are set.
  const socket = new EventEmitter() as EventEmitter & Record<string, unknown>
  socket.destroyed = false
  socket.destroy = vi.fn(() => {
    socket.destroyed = true
  })
  socket.write = vi.fn(() => true)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; only the members the dialer calls are set.
  return socket as unknown as Socket
}

describe('createAuthCallbackDialer', () => {
  it('dials only the granted loopback port', () => {
    const dial = vi.fn(() => fakeSocket())
    const connect = createAuthCallbackDialer(54121, () => {}, dial)
    expect(() => connect({ host: '127.0.0.1', port: 22 })).toThrow(
      'auth_callback_destination_refused'
    )
    expect(() => connect({ host: '10.0.0.5', port: 54121 })).toThrow(
      'auth_callback_destination_refused'
    )
    connect({ host: '127.0.0.1', port: 54121 })
    expect(dial).toHaveBeenCalledExactlyOnceWith(54121)
  })

  it('closes the tunnel past the stream and byte caps', () => {
    const onExceeded = vi.fn()
    const socket = fakeSocket()
    const connect = createAuthCallbackDialer(54121, onExceeded, () => socket)
    const stream = connect({ host: '127.0.0.1', port: 54121 })
    stream.write(new Uint8Array(AUTH_CALLBACK_TUNNEL_MAX_BYTES + 1))
    expect(socket.destroy).toHaveBeenCalled()
    expect(onExceeded).toHaveBeenCalledOnce()
    for (let index = 1; index < AUTH_CALLBACK_TUNNEL_MAX_STREAMS; index += 1) {
      connect({ host: '127.0.0.1', port: 54121 })
    }
    expect(() => connect({ host: '127.0.0.1', port: 54121 })).toThrow('auth_callback_stream_limit')
  })
})
