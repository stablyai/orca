import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from './rpc-client'
import { classifyConnection, verdictDisplayLabel } from './connection-health'

// Issue #10119 — "mobile client fails to connect over cellular and remains stuck
// at connecting". Each scenario below is a way a cellular link fails and what the
// user is shown while it does. On the parent commit ws.onopen reset
// reconnectAttempt before the E2EE handshake completed and classifyConnection
// reverted to "Connecting…" on every redial, so no escalation assertion here
// could pass: the label looped "Connecting…" forever.

vi.mock('./e2ee', () => ({
  generateKeyPair: () => ({ publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) }),
  deriveSharedKey: () => new Uint8Array(32),
  publicKeyFromBase64: () => new Uint8Array(32),
  publicKeyToBase64: () => 'client-public-key',
  encrypt: (plaintext: string) => plaintext,
  decrypt: (raw: string) => raw,
  decryptBytes: (bytes: Uint8Array) => bytes
}))

type CarrierBehavior =
  // Carrier silently drops the SYN to a LAN/CGNAT destination: the socket sits
  // CONNECTING until the client's 12s connect timeout fires.
  | { kind: 'blackhole' }
  // Carrier answers with an RST.
  | { kind: 'refused' }
  // Endpoint completes the WS upgrade, then never speaks (relay accepted the
  // socket but no desktop joined the session).
  | { kind: 'open-then-silent' }
  // Endpoint is healthy but its e2ee_ready lands after readyAfterMs, which a
  // high-latency / lossy cellular link readily pushes past the 5s budget.
  | { kind: 'slow-handshake'; readyAfterMs: number }

let carrier: CarrierBehavior = { kind: 'blackhole' }
const sockets: CarrierWebSocket[] = []

class CarrierWebSocket {
  static CONNECTING = 0
  // Why: sendEncrypted compares readyState against WebSocket.OPEN — the mock
  // must define it or the e2ee_auth write silently fails.
  static OPEN = 1
  static CLOSED = 3
  readonly CONNECTING = 0
  readyState = 0
  onopen: (() => void) | null = null
  onclose: ((event?: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event?: unknown) => void) | null = null

  constructor(readonly endpoint: string) {
    sockets.push(this)
    if (carrier.kind === 'refused') {
      setTimeout(() => this.fail(), 1)
      return
    }
    if (carrier.kind === 'open-then-silent' || carrier.kind === 'slow-handshake') {
      setTimeout(() => {
        this.readyState = 1
        this.onopen?.()
      }, 200)
    }
  }

  send(payload: string): void {
    if (carrier.kind !== 'slow-handshake') {
      return
    }
    if (payload.includes('e2ee_hello')) {
      const delay = carrier.readyAfterMs
      setTimeout(() => {
        if (this.readyState === 1) {
          this.onmessage?.({ data: JSON.stringify({ type: 'e2ee_ready' }) })
        }
      }, delay)
      return
    }
    if (payload.includes('e2ee_auth')) {
      setTimeout(() => {
        if (this.readyState === 1) {
          this.onmessage?.({ data: JSON.stringify({ type: 'e2ee_authenticated' }) })
        }
      }, 10)
    }
  }

  close(): void {
    if (this.readyState === 3) {
      return
    }
    this.fail()
  }

  private fail(): void {
    this.readyState = 3
    this.onerror?.({ message: 'network error' })
    this.onclose?.({ code: 1006, wasClean: false })
  }
}

const originalWebSocket = globalThis.WebSocket

type Sample = { atMs: number; state: string; attempts: number; label: string }

// Walks simulated time recording what every screen would render, since
// classifyConnection is the single label source for home, host, tasks and session.
function observe(endpoint: string, durationMs: number): Sample[] {
  const client = connect(endpoint, 'device-token', 'server-public-key')
  const samples: Sample[] = []
  const stepMs = 250
  for (let atMs = 0; atMs <= durationMs; atMs += stepMs) {
    const state = client.getState()
    const attempts = client.getReconnectAttempt()
    samples.push({
      atMs,
      state,
      attempts,
      label: verdictDisplayLabel(
        classifyConnection({
          state,
          reconnectAttempts: attempts,
          lastConnectedAt: client.getLastConnectedAt(),
          endpoint,
          nowMs: Date.now()
        })
      )
    })
    vi.advanceTimersByTime(stepMs)
  }
  client.close()
  return samples
}

function isEscalated(label: string): boolean {
  return label !== 'Connecting…' && label !== 'Reconnecting…'
}

function labelsAfterFirstEscalation(samples: Sample[]): Sample[] {
  const first = samples.findIndex((s) => isEscalated(s.label))
  expect(first).toBeGreaterThan(0)
  return samples.slice(first)
}

describe('issue #10119 — what a phone shows while it cannot reach the desktop', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    sockets.length = 0
    // @ts-expect-error test double for the RN global
    globalThis.WebSocket = CarrierWebSocket
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    globalThis.WebSocket = originalWebSocket
  })

  it('escalates and stays escalated when the handshake never fits the 5s budget', () => {
    carrier = { kind: 'slow-handshake', readyAfterMs: 6_000 }
    const samples = observe('ws://192.168.0.56:6769', 900_000)

    // 15 minutes of failure against a desktop that is up and answering.
    expect(samples.some((s) => s.state === 'handshaking')).toBe(true)
    expect(samples.some((s) => s.state === 'connected')).toBe(false)

    // The failure counter survives ws.onopen, so both connection-health gates
    // (warning >= 3, unreachable >= 12) are reachable.
    expect(Math.max(...samples.map((s) => s.attempts))).toBeGreaterThanOrEqual(12)
    expect(samples.some((s) => s.label === "Can't connect")).toBe(true)
    expect(samples.some((s) => s.label === "Can't reach desktop")).toBe(true)

    // Once escalated, no later redial reverts the label to "Connecting…".
    const after = labelsAfterFirstEscalation(samples)
    expect(after.every((s) => s.label !== 'Connecting…')).toBe(true)

    // Growing backoff: the pinned counter burned a socket every ~5.6s (~160 in
    // 15 min); with the tiered delays plus the 90s trickle it stays modest.
    expect(sockets.length).toBeGreaterThanOrEqual(5)
    expect(sockets.length).toBeLessThan(30)
  })

  it('escalates when the endpoint accepts the socket and then says nothing', () => {
    carrier = { kind: 'open-then-silent' }
    const samples = observe('ws://relay.example:443', 900_000)

    expect(Math.max(...samples.map((s) => s.attempts))).toBeGreaterThanOrEqual(12)
    expect(samples.some((s) => s.label === "Can't reach desktop")).toBe(true)

    const after = labelsAfterFirstEscalation(samples)
    expect(after.every((s) => s.label !== 'Connecting…')).toBe(true)
  })

  it('latches "Can\'t connect" on a blackholed LAN endpoint instead of reverting each dial', () => {
    carrier = { kind: 'blackhole' }
    const samples = observe('ws://192.168.0.56:6769', 120_000)

    // Three 12s connect timeouts plus backoff: first escalation lands ≈ 37.5s.
    const first = samples.find((s) => isEscalated(s.label))
    expect(first?.atMs ?? Infinity).toBeLessThanOrEqual(40_000)

    // Every later 12s dial window used to flip the label back to "Connecting…".
    const after = labelsAfterFirstEscalation(samples)
    expect(after.every((s) => s.label !== 'Connecting…')).toBe(true)
  })

  it('holds "Can\'t reach desktop" through every trickle dial once past the give-up cap', () => {
    carrier = { kind: 'blackhole' }
    const samples = observe('ws://192.168.0.56:6769', 900_000)

    const firstUnreachable = samples.findIndex((s) => s.label === "Can't reach desktop")
    expect(firstUnreachable).toBeGreaterThan(0)

    // The loop has given up internally (attempts held at the cap); the label
    // must say so through the 12s of every 90s trickle dial, not just between them.
    const after = samples.slice(firstUnreachable)
    expect(after.every((s) => s.attempts >= 12)).toBe(true)
    expect(after.every((s) => s.label === "Can't reach desktop")).toBe(true)
  })

  it('resets the failure counter only once a handshake actually completes', () => {
    carrier = { kind: 'slow-handshake', readyAfterMs: 6_000 }
    const client = connect('ws://192.168.0.56:6769', 'device-token', 'server-public-key')

    vi.advanceTimersByTime(40_000)
    expect(client.getState()).not.toBe('connected')
    expect(client.getReconnectAttempt()).toBeGreaterThanOrEqual(3)

    // The link heals: the same desktop now answers inside the budget.
    carrier = { kind: 'slow-handshake', readyAfterMs: 50 }
    vi.advanceTimersByTime(20_000)
    expect(client.getState()).toBe('connected')
    expect(client.getReconnectAttempt()).toBe(0)

    client.close()
  })

  it('contrast: an endpoint that RSTs escalates the same way', () => {
    carrier = { kind: 'refused' }
    const samples = observe('ws://192.168.0.56:6769', 60_000)

    expect(samples.some((s) => s.label === "Can't connect")).toBe(true)
    const after = labelsAfterFirstEscalation(samples)
    expect(after.every((s) => s.label !== 'Connecting…')).toBe(true)
  })
})
