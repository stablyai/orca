import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from './rpc-client'
import { RpcClientSocketFactory } from './rpc-client-socket-factory'
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

const seenWebSocketArgs: unknown[][] = []

class CapturingWebSocket {
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
  constructor(...args: unknown[]) {
    seenWebSocketArgs.push(args)
  }
  send(): void {}
  close(): void {
    this.readyState = 3
  }
}

const originalWebSocket = globalThis.WebSocket

beforeEach(() => {
  seenWebSocketArgs.length = 0
  vi.stubGlobal('WebSocket', CapturingWebSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
  globalThis.WebSocket = originalWebSocket
  vi.restoreAllMocks()
})

describe('direct socket edge-auth headers', () => {
  it('attaches headers to the WebSocket handshake', () => {
    const headers = { 'CF-Access-Client-Id': 'id-abc', 'CF-Access-Client-Secret': 'secret-xyz' }
    const client = connect('wss://tunnel.example:443/runtime', 'device-token', 'server-key', {
      edgeAuthHeaders: headers
    })

    expect(seenWebSocketArgs).toHaveLength(1)
    expect(seenWebSocketArgs[0]?.[0]).toBe('wss://tunnel.example:443/runtime')
    expect(seenWebSocketArgs[0]?.[2]).toEqual({ headers })
    client.close()
  })

  it('opens a plain socket without headers', () => {
    const client = connect('ws://192.168.1.10:6768', 'device-token', 'server-key', {})

    expect(seenWebSocketArgs).toHaveLength(1)
    expect(seenWebSocketArgs[0]).toHaveLength(1)
    client.close()
  })

  it('logs header names but never values', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const logs: ConnectionLogEntry[] = []
    const client = connect('wss://tunnel.example:443/runtime', 'device-token', 'server-key', {
      onLog: (entry) => logs.push(entry),
      edgeAuthHeaders: { 'CF-Access-Client-Id': 'id-abc', 'CF-Access-Client-Secret': 'secret-xyz' }
    })

    const consoleText = consoleSpy.mock.calls.map((call) => JSON.stringify(call)).join('\n')
    expect(consoleText).toContain('CF-Access-Client-Id')
    expect(consoleText).not.toContain('id-abc')
    expect(consoleText).not.toContain('secret-xyz')
    const opening = logs.find((entry) => entry.message === 'Opening WebSocket')
    expect(opening?.detail).toContain('tunnel.example')
    expect(opening?.detail).toContain('CF-Access-Client-Id')
    expect(opening?.detail).toContain('CF-Access-Client-Secret')
    expect(JSON.stringify(logs)).not.toContain('id-abc')
    expect(JSON.stringify(logs)).not.toContain('secret-xyz')
    client.close()
  })

  it('drops headers for ws:// endpoints instead of sending cleartext', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const logs: ConnectionLogEntry[] = []
    const client = connect('ws://192.168.1.10:6768', 'device-token', 'server-key', {
      onLog: (entry) => logs.push(entry),
      edgeAuthHeaders: { 'CF-Access-Client-Id': 'id-abc' }
    })

    expect(seenWebSocketArgs).toHaveLength(1)
    expect(seenWebSocketArgs[0]).toHaveLength(1)
    const consoleText = consoleSpy.mock.calls.map((call) => JSON.stringify(call)).join('\n')
    expect(consoleText).toContain('non-wss')
    expect(consoleText).not.toContain('id-abc')
    expect(JSON.stringify(logs)).not.toContain('id-abc')
    client.close()
  })

  it('reuses the snapshot across reconnect dials', () => {
    const headers = { 'CF-Access-Client-Id': 'id-abc' }
    const factory = new RpcClientSocketFactory({
      endpoint: 'wss://tunnel.example:443/runtime',
      deviceToken: 'device-token',
      serverPublicKeyB64: 'server-key',
      edgeAuthHeaders: headers,
      getCurrentSocket: () => null,
      getState: () => 'connecting',
      getReconnectAttempt: () => 1,
      getLastConnectedAt: () => null,
      isIntentionallyClosed: () => false,
      emitLog: () => {},
      onHandshakeStarted: () => {},
      onAuthenticated: () => {},
      onAuthRejected: () => {},
      onRpcResponse: () => {},
      onBinary: () => {},
      onAuthenticatedInbound: () => {},
      onClosed: () => {},
      onForcedClose: () => {}
    })

    const first = factory.open()
    const second = factory.open()
    expect(seenWebSocketArgs).toHaveLength(2)
    expect(seenWebSocketArgs[0]?.[2]).toEqual({ headers })
    expect(seenWebSocketArgs[1]?.[2]).toEqual({ headers })
    first.clearTimers()
    second.clearTimers()
  })
})
