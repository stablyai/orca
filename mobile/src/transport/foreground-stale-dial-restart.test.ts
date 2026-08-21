import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from './rpc-client'
import { classifyConnection, verdictDisplayLabel } from './connection-health'

// Slack P0 — "mobile connection issue. was using it with my linux host then
// after i navigated out of the app and back it doesn't work anymore. Now i went
// back again it's connected now."
//
// The tell is that the SECOND foreground fixed it. notifyForeground only ever
// acted on 'connected' (probe the socket) and 'reconnecting' (redial now). A
// phone that is suspended mid-dial resumes in 'connecting'/'handshaking', where
// the nudge did nothing: the user waited out the remainder of the 12s connect
// budget on a socket opened over a network path that no longer existed, and
// then the *preserved* backoff delay — up to 60s of "Connecting…" against a
// desktop that was answering the whole time. By the next foreground the client
// had landed in 'reconnecting', where the nudge works, so it connected at once.

vi.mock('./e2ee', () => ({
  generateKeyPair: () => ({ publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) }),
  deriveSharedKey: () => new Uint8Array(32),
  publicKeyFromBase64: () => new Uint8Array(32),
  publicKeyToBase64: () => 'client-public-key',
  encrypt: (plaintext: string) => `encrypted:${plaintext}`,
  decrypt: (raw: string) => raw.replace(/^encrypted:/, ''),
  decryptBytes: (bytes: Uint8Array) => bytes
}))

// Mirrors React Native's WebSocket: readyState lives in JS and only advances on
// a delivered event, so a socket the OS killed while the app was suspended stays
// CONNECTING forever from the client's point of view.
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
const originalWebSocket = globalThis.WebSocket

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

// A suspended app is not a slow app: wall-clock time passes but not one JS timer
// runs, so the backoff loop does NOT keep cycling in the background. Advancing
// the system clock without draining the timer queue is what reproduces that —
// the connect timer armed before the suspension is still pending on resume, and
// the client is still sitting in the state it was suspended in.
function suspend(backgroundMs: number): void {
  for (const socket of sockets) {
    // iOS reclaims a suspended app's sockets without telling JS.
    socket.deliversCloseEvent = false
  }
  vi.setSystemTime(Date.now() + backgroundMs)
}

// Steps the clock one second at a time and reports how long the user has to sit
// on "Connecting…" before the client opens its next socket.
async function millisecondsUntilNextDial(dialsBefore: number): Promise<number> {
  const limitMs = 180_000
  for (let elapsedMs = 0; elapsedMs <= limitMs; elapsedMs += 1_000) {
    if (sockets.length > dialsBefore) {
      return elapsedMs
    }
    await vi.advanceTimersByTimeAsync(1_000)
  }
  return limitMs
}

// Waits out the current backoff so the phone is suspended mid-dial — the state
// the reporter's phone resumed into — rather than between dials.
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
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    globalThis.WebSocket = originalWebSocket
  })

  it('abandons a dial that predates the foreground edge instead of waiting it out', async () => {
    const client = connect(TAILSCALE_ENDPOINT, 'token', 'server-key')
    latest().authenticate()
    expect(client.getState()).toBe('connected')

    // The user leaves the app. The link dies while the phone is suspended, so
    // the client is left holding a socket that will never open.
    latest().close()
    expect(client.getState()).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(500)
    expect(client.getState()).toBe('connecting')
    const doomed = latest()

    suspend(120_000)

    // Back in the app. The desktop is healthy and answering.
    const socketsBeforeForeground = sockets.length
    client.notifyForeground()

    expect(sockets.length).toBe(socketsBeforeForeground + 1)
    expect(latest()).not.toBe(doomed)
    latest().authenticate()
    expect(client.getState()).toBe('connected')
  })

  it('does not strand the user on "Connecting…" for a minute after returning', async () => {
    const client = connect(TAILSCALE_ENDPOINT, 'token', 'server-key')
    latest().authenticate()
    latest().close()

    // The desktop drops off the network while the user is still in the app, so
    // the tiered backoff climbs into its slow tail (15s, 30s, 60s) before they
    // ever leave. This is what makes the post-resume wait a full minute.
    for (let dial = 0; dial < 6; dial++) {
      await vi.advanceTimersByTimeAsync(12_000 + 60_000)
    }
    expect(client.getReconnectAttempt()).toBeGreaterThanOrEqual(6)
    await advanceUntilDialing(client)

    suspend(90_000)
    const dialsBefore = sockets.length
    client.notifyForeground()

    // The desktop is reachable again and the user is looking at the screen, so
    // the redial has to be in flight now — not after the abandoned socket's
    // connect budget expires and another tail-length backoff is waited out.
    expect(await millisecondsUntilNextDial(dialsBefore)).toBe(0)

    latest().authenticate()
    expect(client.getState()).toBe('connected')
    expect(label(client, TAILSCALE_ENDPOINT)).toBe('Connected')

    client.close()
  })

  it('clears the escalated label once the foreground redial lands', async () => {
    const client = connect(TAILSCALE_ENDPOINT, 'token', 'server-key')
    latest().authenticate()
    latest().close()
    for (let dial = 0; dial < 4; dial++) {
      await vi.advanceTimersByTimeAsync(12_000 + 60_000)
    }
    // Four failed dials is past WARNING_ATTEMPTS, so the card reads "Can't
    // connect — check Tailscale" rather than a neutral "Connecting…".
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

    // The desktop really is gone. Abandoning the stale dial must book the failure
    // it represents, or each visit resets the counter faster than it can climb and
    // the card reassures the user with "Connecting…" indefinitely (issue #10119).
    for (let visit = 0; visit < 14; visit++) {
      await advanceUntilDialing(client)
      suspend(30_000)
      client.notifyForeground()
    }

    expect(client.getReconnectAttempt()).toBeGreaterThanOrEqual(12)
    expect(label(client, TAILSCALE_ENDPOINT)).toBe("Can't reach desktop — check Tailscale")

    // And the escalation is not sticky: the desktop comes back, the card clears.
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

    // A Wi-Fi→cellular handoff fires a second revival nudge right behind the
    // AppState one. It must not churn the dial that the first nudge just opened.
    client.notifyForeground()
    const afterFirstNudge = latest()
    client.notifyForeground()
    client.notifyForeground()

    expect(latest()).toBe(afterFirstNudge)
    expect(fresh.endpoint).toBe(TAILSCALE_ENDPOINT)

    client.close()
  })

  it('abandons a handshake stalled across the suspension', async () => {
    const client = connect(TAILSCALE_ENDPOINT, 'token', 'server-key')
    latest().authenticate()
    latest().close()
    await vi.advanceTimersByTimeAsync(500)

    // The upgrade completed but the desktop never sent e2ee_ready before the
    // phone was suspended — the classic wedged relay/Tailscale half-open.
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
