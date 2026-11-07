import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from './rpc-client'

const serverPublicKeyB64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const nativeWebSocket = vi.fn(function (_endpoint: string) {
  return { readyState: 0, close: vi.fn() }
})

describe('mobile rpc-client socket URL scheme', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    nativeWebSocket.mockClear()
    vi.stubGlobal('WebSocket', nativeWebSocket)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it.each(['iroh://desktop-id', 'IROH://desktop-id', 'https://desktop.invalid'])(
    'rejects %s before calling the native WebSocket constructor',
    (endpoint) => {
      expect(() => connect(endpoint, 'token', serverPublicKeyB64)).toThrow(
        'Unsupported WebSocket URL scheme: expected ws:// or wss://.'
      )
      expect(nativeWebSocket).not.toHaveBeenCalled()
    }
  )

  it.each(['ws://desktop.invalid', 'wss://desktop.invalid'])(
    'constructs a native WebSocket for %s',
    (endpoint) => {
      const client = connect(endpoint, 'token', serverPublicKeyB64)
      expect(nativeWebSocket).toHaveBeenCalledOnce()
      expect(nativeWebSocket).toHaveBeenCalledWith(endpoint)
      client.close()
    }
  )

  it('allows an iroh endpoint when a custom socket factory handles it', () => {
    const endpoint = 'iroh://desktop-id'
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: no socket events fire; construction and teardown only use readyState and close.
    const socket = { readyState: 0, close: vi.fn() } as unknown as WebSocket
    const createSocket = vi.fn(() => socket)
    const client = connect(endpoint, 'token', serverPublicKeyB64, { createSocket })

    expect(createSocket).toHaveBeenCalledWith(endpoint)
    expect(nativeWebSocket).not.toHaveBeenCalled()
    client.close()
  })
})
