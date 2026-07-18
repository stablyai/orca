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

describe('rpc-client ordered endpoint failover (U4)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockSockets.length = 0
    vi.stubGlobal('WebSocket', MockWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  const TS = 'ws://100.102.47.57:6768'
  const LAN = 'ws://192.168.1.10:6768'

  function authenticate(socket: MockWebSocket) {
    socket.open()
    socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
    socket.receive('encrypted:{"type":"e2ee_authenticated"}')
  }

  it('characterization: single-endpoint reconnect bumps attempt once per failed open', async () => {
    const client = connect(TS, 'token', 'server-key')
    mockSockets[0]!.emitCloseOnClose = false
    await vi.advanceTimersByTimeAsync(12_000)
    expect(client.getReconnectAttempt()).toBe(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(mockSockets).toHaveLength(2)
    mockSockets[1]!.emitCloseOnClose = false
    await vi.advanceTimersByTimeAsync(12_000)
    expect(client.getReconnectAttempt()).toBe(2)
    client.close()
  })

  it('cold start walks preferred order and succeeds on secondary within one pass', async () => {
    const dialed: string[] = []
    const client = connect(TS, 'token', 'server-key', {
      endpoints: [TS, LAN],
      onDialSuccess: (ep) => dialed.push(ep)
    })
    expect(mockSockets[0]!.endpoint).toBe(TS)
    mockSockets[0]!.emitCloseOnClose = false
    await vi.advanceTimersByTimeAsync(12_000)
    expect(mockSockets).toHaveLength(2)
    expect(mockSockets[1]!.endpoint).toBe(LAN)
    expect(client.getReconnectAttempt()).toBe(0)
    authenticate(mockSockets[1]!)
    expect(client.getState()).toBe('connected')
    expect(dialed).toEqual([LAN])
    client.close()
  })

  it('fresh connect with persisted lastGoodEndpoint dials sticky first', async () => {
    const client = connect(TS, 'token', 'server-key', {
      endpoints: [TS, LAN],
      lastGoodEndpoint: LAN
    })
    expect(mockSockets[0]!.endpoint).toBe(LAN)
    authenticate(mockSockets[0]!)
    expect(client.getState()).toBe('connected')
    client.close()
  })

  it('bumps reconnectAttempt once per full ordered pass, not per endpoint', async () => {
    const client = connect(TS, 'token', 'server-key', { endpoints: [TS, LAN] })
    mockSockets[0]!.emitCloseOnClose = false
    await vi.advanceTimersByTimeAsync(12_000)
    expect(mockSockets).toHaveLength(2)
    expect(client.getReconnectAttempt()).toBe(0)
    mockSockets[1]!.emitCloseOnClose = false
    await vi.advanceTimersByTimeAsync(12_000)
    expect(client.getReconnectAttempt()).toBe(1)
    client.close()
  })

  it('after LAN success, reconnect prefers LAN first (AE2 sticky)', async () => {
    const client = connect(TS, 'token', 'server-key', { endpoints: [TS, LAN] })
    mockSockets[0]!.emitCloseOnClose = false
    await vi.advanceTimersByTimeAsync(12_000)
    authenticate(mockSockets[1]!)
    expect(client.getState()).toBe('connected')

    mockSockets[mockSockets.length - 1]!.close()
    expect(client.getState()).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(500)
    expect(mockSockets[mockSockets.length - 1]!.endpoint).toBe(LAN)
    client.close()
  })

  it('after one sticky last-good miss, continues preferred order (leave-home)', async () => {
    const client = connect(TS, 'token', 'server-key', { endpoints: [TS, LAN] })
    mockSockets[0]!.emitCloseOnClose = false
    await vi.advanceTimersByTimeAsync(12_000)
    authenticate(mockSockets[1]!)

    // Drop; sticky reconnect tries LAN first and misses once.
    mockSockets[mockSockets.length - 1]!.close()
    await vi.advanceTimersByTimeAsync(500)
    const stickyLan = mockSockets[mockSockets.length - 1]!
    expect(stickyLan.endpoint).toBe(LAN)
    stickyLan.emitCloseOnClose = false
    await vi.advanceTimersByTimeAsync(12_000)

    // Same pass continues preferred order → Tailscale can recover without give-up.
    const next = mockSockets[mockSockets.length - 1]!
    expect(next.endpoint).toBe(TS)
    // One bump for the reconnect pass that started after the live drop (KTD3).
    expect(client.getReconnectAttempt()).toBe(1)
    authenticate(next)
    expect(client.getState()).toBe('connected')
    expect(client.getReconnectAttempt()).toBe(0)
    client.close()
  })

  it('does not advance to the next endpoint on unauthorized', async () => {
    const client = connect(TS, 'token', 'server-key', { endpoints: [TS, LAN] })
    const first = mockSockets[0]!
    first.open()
    first.receive(JSON.stringify({ type: 'e2ee_ready' }))
    first.receive('encrypted:{"type":"e2ee_error","error":{"code":"unauthorized"}}')
    expect(client.getState()).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(500)
    expect(mockSockets[mockSockets.length - 1]!.endpoint).toBe(TS)
    client.close()
  })

  it('releases an auth pin when that address later becomes unreachable', async () => {
    const client = connect(TS, 'token', 'server-key', { endpoints: [TS, LAN] })
    const first = mockSockets[0]!
    first.open()
    first.receive(JSON.stringify({ type: 'e2ee_ready' }))
    first.receive('encrypted:{"type":"e2ee_error","error":{"code":"unauthorized"}}')

    await vi.advanceTimersByTimeAsync(500)
    const pinnedRetry = mockSockets[mockSockets.length - 1]!
    expect(pinnedRetry.endpoint).toBe(TS)
    pinnedRetry.emitCloseOnClose = false
    await vi.advanceTimersByTimeAsync(12_000)

    const alternative = mockSockets[mockSockets.length - 1]!
    expect(alternative.endpoint).toBe(LAN)
    authenticate(alternative)
    expect(client.getState()).toBe('connected')
    client.close()
  })

  it('after sticky miss, a later reconnect pass starts at preferred order not last-good', async () => {
    const client = connect(TS, 'token', 'server-key', { endpoints: [TS, LAN] })
    mockSockets[0]!.emitCloseOnClose = false
    await vi.advanceTimersByTimeAsync(12_000)
    authenticate(mockSockets[1]!)

    mockSockets[mockSockets.length - 1]!.close()
    await vi.advanceTimersByTimeAsync(500)
    // Sticky LAN miss…
    mockSockets[mockSockets.length - 1]!.emitCloseOnClose = false
    await vi.advanceTimersByTimeAsync(12_000)
    // …then TS miss → pass exhausted (attempt bumps once for this full pass).
    mockSockets[mockSockets.length - 1]!.emitCloseOnClose = false
    await vi.advanceTimersByTimeAsync(12_000)
    expect(client.getReconnectAttempt()).toBe(2)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(mockSockets[mockSockets.length - 1]!.endpoint).toBe(TS)
    client.close()
  })

  it('pair-time connectTimeoutMs advances endpoints on the shorter budget', async () => {
    const client = connect(TS, 'token', 'server-key', {
      endpoints: [TS, LAN],
      connectTimeoutMs: 5_500
    })
    mockSockets[0]!.emitCloseOnClose = false
    await vi.advanceTimersByTimeAsync(5_500)
    expect(mockSockets).toHaveLength(2)
    expect(mockSockets[1]!.endpoint).toBe(LAN)
    authenticate(mockSockets[1]!)
    expect(client.getState()).toBe('connected')
    client.close()
  })
})
