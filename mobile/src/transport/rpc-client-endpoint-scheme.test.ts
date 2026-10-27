import { afterEach, describe, expect, it, vi } from 'vitest'
import { connect } from './rpc-client'

vi.mock('./direct-e2ee-framing-policy', () => import('./legacy-direct-framing-test-policy'))
vi.mock('./e2ee', () => ({ publicKeyFromBase64: () => new Uint8Array(32) }))

const IROH_ENDPOINT = `iroh://${'a'.repeat(64)}`

function fakeSocket(): WebSocket {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the session only attaches handlers and closes this socket before it opens.
  return { readyState: 0, close: vi.fn() } as unknown as WebSocket
}

describe('rpc-client endpoint scheme', () => {
  const originalWebSocket = globalThis.WebSocket
  afterEach(() => {
    globalThis.WebSocket = originalWebSocket
  })

  it('never hands a non-WebSocket endpoint to the native WebSocket', () => {
    const nativeWebSocket = vi.fn(fakeSocket)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the spy stands in for the global constructor the session calls.
    globalThis.WebSocket = nativeWebSocket as unknown as typeof WebSocket

    expect(() => connect(IROH_ENDPOINT, 'token', 'server-key')).toThrow(
      'Unsupported WebSocket endpoint'
    )
    expect(nativeWebSocket).not.toHaveBeenCalled()
  })

  it('lets an injected socket (native iroh) own a non-WebSocket endpoint', () => {
    const createSocket = vi.fn(fakeSocket)
    const client = connect(IROH_ENDPOINT, 'token', 'server-key', { createSocket })

    expect(createSocket).toHaveBeenCalledWith(IROH_ENDPOINT)
    client.close()
  })
})
