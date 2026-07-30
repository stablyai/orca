// Why: separate from rpc-client.test.ts — that file sits at its max-lines cap,
// and the silent-4001 mapping (desktop lost its device registry / regenerated
// its keypair, so the encrypted e2ee_error never decrypts) is its own scenario.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from './rpc-client'

vi.mock('./e2ee', () => ({
  generateKeyPair: () => ({
    publicKey: new Uint8Array(32),
    secretKey: new Uint8Array(32)
  }),
  deriveSharedKey: () => new Uint8Array(32),
  publicKeyFromBase64: () => new Uint8Array(32),
  publicKeyToBase64: () => 'client-public-key',
  encrypt: (plaintext: string) => `encrypted:${plaintext}`,
  decrypt: (raw: string) => (raw === 'undecryptable' ? null : raw.replace(/^encrypted:/, '')),
  decryptBytes: (bytes: Uint8Array) => bytes
}))

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readonly CONNECTING = MockWebSocket.CONNECTING
  readonly OPEN = MockWebSocket.OPEN
  readonly CLOSING = MockWebSocket.CLOSING
  readonly CLOSED = MockWebSocket.CLOSED

  readyState = MockWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onclose: ((event?: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []
  close = vi.fn(() => {
    if (this.readyState === MockWebSocket.CLOSED) {
      return
    }
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  })

  constructor(readonly endpoint: string) {
    mockSockets.push(this)
  }

  send(payload: string): void {
    this.sent.push(payload)
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: payload })
  }

  serverClose(code: number, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({ code, reason, wasClean: true })
  }
}

const mockSockets: MockWebSocket[] = []
const originalWebSocket = globalThis.WebSocket

function lastSocket(): MockWebSocket {
  return mockSockets[mockSockets.length - 1]!
}

describe('unauthorized close-code mapping (silent 4001)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockSockets.length = 0
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.WebSocket = originalWebSocket
  })

  it('counts a bare 4001 close against the auth retry budget and latches auth-failed', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')

    // A desktop with a regenerated keypair can't send a decryptable e2ee_error —
    // the phone only ever sees the 4001 close. Three of those must latch.
    for (let i = 0; i < 3; i++) {
      if (i > 0) {
        await vi.advanceTimersByTimeAsync(500)
      }
      const socket = lastSocket()
      socket.open()
      socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
      socket.serverClose(4001, 'Unauthorized')
    }

    expect(client.getState()).toBe('auth-failed')
    expect(mockSockets).toHaveLength(3)
    expect(vi.getTimerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(mockSockets).toHaveLength(3)

    client.close()
  })

  it('recovers when a 4001 close was transient and the next handshake succeeds', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const first = mockSockets[0]!
    first.open()
    first.receive(JSON.stringify({ type: 'e2ee_ready' }))
    first.serverClose(4001, 'Unauthorized')
    expect(client.getState()).toBe('reconnecting')

    await vi.advanceTimersByTimeAsync(500)
    const next = lastSocket()
    next.open()
    next.receive(JSON.stringify({ type: 'e2ee_ready' }))
    next.receive('encrypted:{"type":"e2ee_authenticated"}')
    expect(client.getState()).toBe('connected')

    client.close()
  })

  it('shares one budget between decrypted e2ee_error rejections and 4001 closes', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')

    for (let i = 0; i < 3; i++) {
      if (i > 0) {
        await vi.advanceTimersByTimeAsync(500)
      }
      const socket = lastSocket()
      socket.open()
      socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
      if (i < 2) {
        socket.receive('encrypted:{"type":"e2ee_error","error":{"code":"unauthorized"}}')
      } else {
        socket.serverClose(4001, 'Unauthorized')
      }
    }

    expect(client.getState()).toBe('auth-failed')

    client.close()
  })

  it('keeps the generic reconnect loop for non-4001 closes', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')

    for (let i = 0; i < 5; i++) {
      if (i > 0) {
        await vi.advanceTimersByTimeAsync(60_000)
      }
      const socket = lastSocket()
      socket.open()
      socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
      socket.serverClose(1006)
    }

    expect(client.getState()).toBe('reconnecting')

    client.close()
  })
})
