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
  decrypt: (raw: string) => raw.replace(/^encrypted:/, ''),
  decryptBytes: (bytes: Uint8Array) => bytes
}))

vi.mock('../connection/mobile-runtime-capability-negotiation', () => ({
  negotiateMobileRuntimeCapabilities: (args: { onReady: () => void }) => args.onReady()
}))

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3

  readonly CONNECTING = MockWebSocket.CONNECTING
  readonly OPEN = MockWebSocket.OPEN
  readonly CLOSED = MockWebSocket.CLOSED
  readyState = MockWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  readonly sent: string[] = []
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  })

  constructor() {
    sockets.push(this)
  }

  send(payload: string): void {
    this.sent.push(payload)
  }

  authenticate(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
    this.onmessage?.({ data: JSON.stringify({ type: 'e2ee_ready' }) })
    this.onmessage?.({ data: 'encrypted:{"type":"e2ee_authenticated"}' })
  }
}

const sockets: MockWebSocket[] = []
const originalWebSocket = globalThis.WebSocket

function lastRequestId(socket: MockWebSocket): string {
  const value: unknown = JSON.parse(socket.sent.at(-1)?.replace(/^encrypted:/, '') ?? 'null')
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') {
    throw new Error('Expected a written request')
  }
  return value.id
}

beforeEach(() => {
  vi.useFakeTimers()
  sockets.length = 0
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies the socket constructor, states, handlers, send and close consumed by the client.
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
})

afterEach(() => {
  vi.useRealTimers()
  globalThis.WebSocket = originalWebSocket
})

describe('physical session liveness', () => {
  it('ignores superseded probes and unrelated RPC replies during a control check', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = sockets[0]!
    socket.authenticate()
    const request = client.sendRequest('status.get')
    await vi.advanceTimersByTimeAsync(0)
    const requestId = lastRequestId(socket)
    client.notifyForeground('focus')
    const firstProbe = lastRequestId(socket)
    await vi.advanceTimersByTimeAsync(8_000)
    await vi.advanceTimersByTimeAsync(7_000)
    for (const id of [firstProbe, requestId]) {
      socket.onmessage?.({ data: `encrypted:${JSON.stringify({ id, ok: true, result: {} })}` })
    }
    expect((await request).ok).toBe(true)
    await vi.advanceTimersByTimeAsync(9_000)
    expect(client.getState()).toBe('reconnecting')
    client.close()
  })
})
