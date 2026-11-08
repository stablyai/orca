import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from './rpc-client'
import { classifyConnection, verdictDisplayLabel } from './connection-health'

// Resume must replace stale connecting/handshaking sockets immediately; otherwise only a second foreground escapes the old dial/backoff.

vi.mock('./direct-e2ee-framing-policy', () => import('./legacy-direct-framing-test-policy'))

vi.mock('./e2ee', () => ({
  generateKeyPair: () => ({ publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) }),
  deriveSharedKey: () => new Uint8Array(32),
  publicKeyFromBase64: () => new Uint8Array(32),
  publicKeyToBase64: () => 'client-public-key',
  encrypt: (plaintext: string) => `encrypted:${plaintext}`,
  decrypt: (raw: string) => raw.replace(/^encrypted:/, ''),
  decryptBytes: (bytes: Uint8Array) => bytes
}))

vi.mock('./mobile-runtime-capability-negotiation', () => ({
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

function label(client: ReturnType<typeof connect>, endpoint: string): string {
  return verdictDisplayLabel(
    classifyConnection({
      state: client.getState(),
      reconnectAttempts: client.getReconnectAttempt(),
      lastConnectedAt: client.getLastConnectedAt(),
      endpoint,
      nowMs: Date.now()
    })
  )
}

// Advance wall time without timers to model suspension; the original dial deadline must still be pending on resume.
function suspend(backgroundMs: number): void {
  for (const socket of sockets) {
    socket.deliversCloseEvent = false
  }
  vi.setSystemTime(Date.now() + backgroundMs)
}

// Suspend during a dial, after backoff, to exercise the stale connecting state.
async function advanceUntilDialing(client: ReturnType<typeof connect>): Promise<void> {
  for (let elapsedMs = 0; elapsedMs <= 120_000; elapsedMs += 250) {
    if (client.getState() === 'connecting') {
      return
    }
    await vi.advanceTimersByTimeAsync(250)
  }
  throw new Error(`client never re-entered connecting (state=${client.getState()})`)
}

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

  it('abandons a dial that predates the foreground edge instead of waiting it out', async () => {
    const client = connect(TAILSCALE_ENDPOINT, 'token', 'server-key')
    latest().authenticate()
    expect(client.getState()).toBe('connected')

    latest().close()
    expect(client.getState()).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(500)
    expect(client.getState()).toBe('connecting')
    const doomed = latest()

    suspend(120_000)

    const socketsBeforeForeground = sockets.length
    client.notifyForeground()

    expect(sockets.length).toBe(socketsBeforeForeground + 1)
    expect(latest()).not.toBe(doomed)
    expect(doomed.readyState).toBe(MockWebSocket.CLOSED)
    latest().authenticate()
    expect(client.getState()).toBe('connected')
    client.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the escalated label once the foreground redial lands', async () => {
    const client = connect(TAILSCALE_ENDPOINT, 'token', 'server-key')
    latest().authenticate()
    latest().close()
    for (let dial = 0; dial < 4; dial++) {
      await vi.advanceTimersByTimeAsync(12_000 + 60_000)
    }
    expect(label(client, TAILSCALE_ENDPOINT)).toBe("Can't connect — check Tailscale")
    await advanceUntilDialing(client)
    const doomed = latest()

    suspend(120_000)
    client.notifyForeground()

    expect(latest()).not.toBe(doomed)
    latest().authenticate()
    expect(client.getState()).toBe('connected')
    expect(client.getReconnectAttempt()).toBe(0)
    expect(label(client, TAILSCALE_ENDPOINT)).toBe('Connected')

    client.close()
  })

  it('keeps escalating when the user checks back repeatedly during a real outage', async () => {
    const client = connect(TAILSCALE_ENDPOINT, 'token', 'server-key')
    latest().authenticate()
    latest().close()

    // Book abandoned stale dials as failures so repeated foregrounds cannot reset escalation indefinitely (#10119).
    for (let visit = 0; visit < 14; visit++) {
      await advanceUntilDialing(client)
      suspend(30_000)
      client.notifyForeground()
    }

    expect(client.getReconnectAttempt()).toBeGreaterThanOrEqual(12)
    expect(label(client, TAILSCALE_ENDPOINT)).toBe("Can't reach desktop — check Tailscale")

    latest().authenticate()
    expect(label(client, TAILSCALE_ENDPOINT)).toBe('Connected')

    client.close()
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
