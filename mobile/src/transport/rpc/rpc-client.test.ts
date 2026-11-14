import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from './direct-rpc-connect'

vi.mock(
  '../encryption/direct-e2ee-framing-policy',
  () => import('./legacy-direct-framing-test-policy')
)

vi.mock('../encryption/e2ee', () => ({
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

// Capability ordering has dedicated coverage; keep connection tests focused on socket behavior.
vi.mock('../connection/mobile-runtime-capability-negotiation', () => ({
  negotiateMobileRuntimeCapabilities: (args: { onReady: () => void }) => args.onReady()
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
  onclose: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  emitCloseOnClose = true
  sent: string[] = []
  close = vi.fn(() => {
    if (this.readyState === MockWebSocket.CLOSED) {
      return
    }
    this.readyState = MockWebSocket.CLOSED
    if (this.emitCloseOnClose) {
      this.onclose?.()
    }
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
}

const mockSockets: MockWebSocket[] = []
const originalWebSocket = globalThis.WebSocket

function openAndAuthenticate(socket: MockWebSocket) {
  socket.open()
  socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
  socket.receive('encrypted:{"type":"e2ee_authenticated"}')
}

describe('mobile rpc-client connection timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockSockets.length = 0
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.WebSocket = originalWebSocket
  })

  // Transient auth rejection must not force re-pairing while the desktop still has valid credentials (#5200).
  describe('auth rejection retry (issue #5200)', () => {
    it('retries the handshake on a transient e2ee_error instead of latching auth-failed', async () => {
      const client = connect('ws://desktop.invalid', 'token', 'server-key')
      const first = mockSockets[0]!
      first.open()
      first.receive(JSON.stringify({ type: 'e2ee_ready' }))

      first.receive('encrypted:{"type":"e2ee_error","error":{"code":"unauthorized"}}')
      expect(client.getState()).toBe('reconnecting')

      await vi.advanceTimersByTimeAsync(500)
      openAndAuthenticate(mockSockets.at(-1)!)
      expect(client.getState()).toBe('connected')

      client.close()
    })
  })
})
