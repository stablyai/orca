import { afterEach, describe, expect, it, vi } from 'vitest'
import { DirectConnectionLog } from './direct-connection-log'
import { connect } from './rpc-client'
import type { ConnectionLogEntry } from './types'

vi.mock('./e2ee', () => ({
  generateKeyPair: () => ({
    publicKey: new Uint8Array(32),
    secretKey: new Uint8Array(32)
  }),
  deriveSharedKey: () => new Uint8Array(32),
  publicKeyFromBase64: () => new Uint8Array(32),
  publicKeyToBase64: () => 'client-public-key',
  encrypt: (plaintext: string) => plaintext,
  decrypt: (raw: string) => raw,
  decryptBytes: (bytes: Uint8Array) => bytes
}))

class NeverOpeningWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  send(): void {}
  close(): void {
    this.readyState = 3
  }
}

const originalWebSocket = globalThis.WebSocket

afterEach(() => {
  globalThis.WebSocket = originalWebSocket
})

describe('mobile rpc-client connection logs', () => {
  it.each([
    ['ws://192.168.1.2:6768', 'lan'],
    ['ws://100.88.90.25:6768', 'tailscale'],
    ['iroh://desktop-endpoint', 'iroh']
  ])('attributes connection logs for %s to %s', (endpoint, path) => {
    const logs: ConnectionLogEntry[] = []
    new DirectConnectionLog(endpoint, (entry) => logs.push(entry)).emit('info', 'diagnostic')
    expect(logs.map((entry) => entry.path)).toEqual([path])
  })

  it('never exposes endpoint query credentials', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This socket fixture supplies the constructor, states, handlers, send and close consumed by the real client.
    globalThis.WebSocket = NeverOpeningWebSocket as unknown as typeof WebSocket
    const logs: ConnectionLogEntry[] = []
    const endpoint = 'wss://desktop.example:7443/runtime?token=super-secret&route=private'

    const client = connect(endpoint, 'device-token', 'server-key', {
      onLog: (entry) => logs.push(entry)
    })

    expect(logs).toContainEqual(expect.objectContaining({ detail: 'desktop.example:7443' }))
    expect(JSON.stringify(logs)).not.toContain('super-secret')
    expect(JSON.stringify(logs)).not.toContain('route=private')
    client.close()
  })

  it('does not expose URL credentials in malformed legacy endpoints', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This socket fixture supplies the constructor, states, handlers, send and close consumed by the real client.
    globalThis.WebSocket = NeverOpeningWebSocket as unknown as typeof WebSocket
    const logs: ConnectionLogEntry[] = []

    const client = connect('wss://user:password@desktop.example:7443/runtime', 'token', 'key', {
      onLog: (entry) => logs.push(entry)
    })

    expect(logs[0]?.detail).toBe('desktop.example:7443')
    expect(JSON.stringify(logs)).not.toContain('password')
    client.close()
  })
})
