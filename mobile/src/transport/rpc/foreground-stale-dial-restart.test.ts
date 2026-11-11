import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from './direct-rpc-connect'

// Resume must replace stale connecting/handshaking sockets immediately; otherwise only a second foreground escapes the old dial/backoff.

vi.mock(
  '../encryption/direct-e2ee-framing-policy',
  () => import('./legacy-direct-framing-test-policy')
)

vi.mock('../encryption/e2ee', () => ({
  generateKeyPair: () => ({ publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) }),
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

// Mirror RN’s event-driven readyState: OS-killed suspended sockets may remain CONNECTING in JS.
class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  readonly CONNECTING = 0
  readonly OPEN = 1

  readyState = MockWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onclose: ((event?: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event?: unknown) => void) | null = null
  // A socket the OS tore down while suspended never reports its own close.
  deliversCloseEvent = true
  sent: string[] = []

  constructor(readonly endpoint: string) {
    sockets.push(this)
  }

  send(payload: string): void {
    this.sent.push(payload)
  }

  close(): void {
    if (this.readyState === MockWebSocket.CLOSED) {
      return
    }
    this.readyState = MockWebSocket.CLOSED
    if (this.deliversCloseEvent) {
      this.onclose?.({ code: 1006, wasClean: false })
    }
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }

  authenticate(): void {
    this.open()
    this.onmessage?.({ data: JSON.stringify({ type: 'e2ee_ready' }) })
    this.onmessage?.({ data: 'encrypted:{"type":"e2ee_authenticated"}' })
  }
}

const sockets: MockWebSocket[] = []

function latest(): MockWebSocket {
  const socket = sockets[sockets.length - 1]
  if (!socket) {
    throw new Error('no socket opened')
  }
  return socket
}

// Advance wall time without timers to model suspension; the original dial deadline must still be pending on resume.
function suspend(backgroundMs: number): void {
  for (const socket of sockets) {
    socket.deliversCloseEvent = false
  }
  vi.setSystemTime(Date.now() + backgroundMs)
}

// Suspend during a dial, after backoff, to exercise the stale connecting state.

const TAILSCALE_ENDPOINT = 'ws://100.84.12.9:6769'

describe('foregrounding a phone that was suspended mid-dial', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    sockets.length = 0
    vi.stubGlobal('WebSocket', MockWebSocket)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('leaves a dial opened after the foreground edge alone', async () => {
    const client = connect(TAILSCALE_ENDPOINT, 'token', 'server-key')
    latest().authenticate()
    latest().close()
    await vi.advanceTimersByTimeAsync(500)
    const fresh = latest()
    expect(client.getState()).toBe('connecting')

    // Coalesce handoff and AppState nudges so the second cannot churn the first’s fresh socket.
    client.notifyForeground()
    const afterFirstNudge = latest()
    client.notifyForeground()
    client.notifyForeground()

    expect(latest()).toBe(afterFirstNudge)
    expect(afterFirstNudge).toBe(fresh)
    expect(fresh.readyState).toBe(MockWebSocket.CONNECTING)

    client.close()
  })

  it('abandons a handshake stalled across the suspension', async () => {
    const client = connect(TAILSCALE_ENDPOINT, 'token', 'server-key')
    latest().authenticate()
    latest().close()
    await vi.advanceTimersByTimeAsync(500)

    // Suspend after upgrade but before E2EE readiness to model a half-open handshake.
    latest().open()
    expect(client.getState()).toBe('handshaking')
    const wedged = latest()

    suspend(120_000)
    client.notifyForeground()

    expect(latest()).not.toBe(wedged)
    latest().authenticate()
    expect(client.getState()).toBe('connected')

    client.close()
  })
})
