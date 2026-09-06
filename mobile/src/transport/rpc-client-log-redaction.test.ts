import { afterEach, describe, expect, it, vi } from 'vitest'
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
  static latest: NeverOpeningWebSocket | null = null
  readyState = 0
  onopen: (() => void) | null = null
  onclose: ((event: Record<string, unknown>) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: Record<string, unknown>) => void) | null = null
  constructor(readonly url: string) {
    NeverOpeningWebSocket.latest = this
  }
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
  it('never exposes paired endpoint identity or query credentials', () => {
    globalThis.WebSocket = NeverOpeningWebSocket as unknown as typeof WebSocket
    const logs: ConnectionLogEntry[] = []
    const endpoint = 'wss://desktop.example:7443/runtime?token=super-secret&route=private'

    const client = connect(endpoint, 'device-token', 'server-key', {
      onLog: (entry) => logs.push(entry)
    })

    expect(logs).toContainEqual(
      expect.objectContaining({ message: 'Opening WebSocket', detail: 'encrypted-websocket' })
    )
    const serialized = JSON.stringify(logs)
    expect(serialized).not.toContain('desktop.example')
    expect(serialized).not.toContain('super-secret')
    expect(serialized).not.toContain('route=private')
    client.close()
  })

  it('does not expose URL credentials in malformed legacy endpoints', () => {
    globalThis.WebSocket = NeverOpeningWebSocket as unknown as typeof WebSocket
    const logs: ConnectionLogEntry[] = []

    const client = connect('wss://user:password@desktop.example:7443/runtime', 'token', 'key', {
      onLog: (entry) => logs.push(entry)
    })

    expect(logs[0]?.detail).toBe('encrypted-websocket')
    const serialized = JSON.stringify(logs)
    expect(serialized).not.toContain('desktop.example')
    expect(serialized).not.toContain('password')
    client.close()
  })

  it('does not serialize endpoint, auth, or socket-event values to console', () => {
    globalThis.WebSocket = NeverOpeningWebSocket as unknown as typeof WebSocket
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    const client = connect(
      'wss://private-desktop.example/runtime?token=url-secret',
      'device-secret',
      'server-key'
    )
    const socket = NeverOpeningWebSocket.latest
    if (!socket) {
      throw new Error('WebSocket was not created')
    }
    socket.onerror?.({
      endpoint: 'wss://private-desktop.example',
      message: 'socket-secret /private/repository',
      type: 'error'
    })
    socket.onclose?.({
      code: 1006,
      reason: 'close-secret /private/repository',
      wasClean: false
    })
    client.close()

    const authClient = connect(
      'wss://private-desktop.example/runtime?token=url-secret',
      'device-secret',
      'server-key'
    )
    const authSocket = NeverOpeningWebSocket.latest
    if (!authSocket) {
      throw new Error('WebSocket was not created')
    }
    authSocket.onopen?.()
    authSocket.onmessage?.({
      data: JSON.stringify({
        type: 'e2ee_error',
        error: {
          code: 'unauthorized',
          message: 'credential-secret /private/repository'
        }
      })
    })
    authClient.close()

    const consoleOutput = JSON.stringify(consoleLog.mock.calls)
    expect(consoleOutput).toContain('encrypted-websocket')
    for (const secret of [
      'private-desktop.example',
      'url-secret',
      'device-secret',
      'credential-secret',
      'socket-secret',
      'close-secret',
      '/private/repository'
    ]) {
      expect(consoleOutput).not.toContain(secret)
    }
  })
})
