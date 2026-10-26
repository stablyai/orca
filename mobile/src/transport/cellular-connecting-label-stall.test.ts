import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from './rpc-client'
import { classifyConnection, verdictDisplayLabel } from './connection-health'

// Keep escalation through socket opens/redials until E2EE succeeds; otherwise cellular failures loop on Connecting (#10119).

vi.mock('./direct-e2ee-framing-policy', () => import('./legacy-direct-framing-test-policy'))

vi.mock('./e2ee', () => ({
  generateKeyPair: () => ({ publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) }),
  deriveSharedKey: () => new Uint8Array(32),
  publicKeyFromBase64: () => new Uint8Array(32),
  publicKeyToBase64: () => 'client-public-key',
  encrypt: (plaintext: string) => plaintext,
  decrypt: (raw: string) => raw,
  decryptBytes: (bytes: Uint8Array) => bytes
}))

vi.mock('./mobile-runtime-capability-negotiation', () => ({
  negotiateMobileRuntimeCapabilities: (args: { onReady: () => void }) => args.onReady()
}))

type CarrierBehavior =
  // Model a silent SYN drop until the connect deadline.
  | { kind: 'blackhole' }
  | { kind: 'refused' }
  // Model a relay upgrade with no desktop handshake response.
  | { kind: 'open-then-silent' }
  | { kind: 'slow-handshake'; readyAfterMs: number }
  // Model a half-open native socket that never emits close, even after close().
  | { kind: 'wedged-open-then-silent' }

let carrier: CarrierBehavior = { kind: 'blackhole' }
const sockets: CarrierWebSocket[] = []

class CarrierWebSocket {
  static CONNECTING = 0
  // The mock needs WebSocket.OPEN for encrypted auth writes to pass readiness checks.
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
    if (
      carrier.kind === 'open-then-silent' ||
      carrier.kind === 'slow-handshake' ||
      carrier.kind === 'wedged-open-then-silent'
    ) {
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
    if (carrier.kind === 'wedged-open-then-silent') {
      this.readyState = 3
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

    expect(samples.some((s) => s.state === 'handshaking')).toBe(true)
    expect(samples.some((s) => s.state === 'connected')).toBe(false)

    expect(Math.max(...samples.map((s) => s.attempts))).toBeGreaterThanOrEqual(12)
    expect(samples.some((s) => s.label === "Can't connect")).toBe(true)
    expect(samples.some((s) => s.label === "Can't reach desktop")).toBe(true)

    const after = labelsAfterFirstEscalation(samples)
    expect(after.every((s) => s.label !== 'Connecting…')).toBe(true)

    // Keep retry counts bounded by backoff/trickle rather than burning a socket every handshake deadline.
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

    // Three connect deadlines plus backoff must reach warning within this bound.
    const first = samples.find((s) => isEscalated(s.label))
    expect(first?.atMs ?? Infinity).toBeLessThanOrEqual(40_000)

    const after = labelsAfterFirstEscalation(samples)
    expect(after.every((s) => s.label !== 'Connecting…')).toBe(true)
  })

  it('holds "Can\'t reach desktop" through every trickle dial once past the give-up cap', () => {
    carrier = { kind: 'blackhole' }
    const samples = observe('ws://192.168.0.56:6769', 900_000)

    const firstUnreachable = samples.findIndex((s) => s.label === "Can't reach desktop")
    expect(firstUnreachable).toBeGreaterThan(0)

    // Keep the unreachable verdict throughout each trickle dial, not only between dials.
    const after = samples.slice(firstUnreachable)
    expect(after.every((s) => s.attempts >= 12)).toBe(true)
    expect(after.every((s) => s.label === "Can't reach desktop")).toBe(true)
  })

  it('resets the failure counter only once a handshake actually completes', async () => {
    carrier = { kind: 'slow-handshake', readyAfterMs: 6_000 }
    const client = connect('ws://192.168.0.56:6769', 'device-token', 'server-public-key')

    // Flush promise jobs between timers because auth is awaited.
    await vi.advanceTimersByTimeAsync(40_000)
    expect(client.getState()).not.toBe('connected')
    expect(client.getReconnectAttempt()).toBeGreaterThanOrEqual(3)

    carrier = { kind: 'slow-handshake', readyAfterMs: 50 }
    await vi.advanceTimersByTimeAsync(20_000)
    expect(client.getState()).toBe('connected')
    expect(client.getReconnectAttempt()).toBe(0)

    client.close()
  })

  it('redials after a handshake timeout the wedged transport never reports as closed', () => {
    carrier = { kind: 'wedged-open-then-silent' }
    const client = connect('ws://192.168.0.56:6769', 'device-token', 'server-public-key')

    vi.advanceTimersByTime(5_400)

    // A missing close callback must not strand handshaking without a retry or foreground recovery.
    expect(sockets).toHaveLength(1)
    expect(client.getState()).toBe('reconnecting')

    vi.advanceTimersByTime(1_000)
    expect(sockets).toHaveLength(2)

    client.close()
  })

  it('escalates past "Connecting…" while every wedged dial swallows its close event', () => {
    carrier = { kind: 'wedged-open-then-silent' }
    const samples = observe('ws://192.168.0.56:6769', 900_000)

    expect(Math.max(...samples.map((s) => s.attempts))).toBeGreaterThanOrEqual(12)
    expect(samples.some((s) => s.label === "Can't reach desktop")).toBe(true)

    const after = labelsAfterFirstEscalation(samples)
    expect(after.every((s) => s.label !== 'Connecting…')).toBe(true)
  })

  it('contrast: an endpoint that RSTs escalates the same way', () => {
    carrier = { kind: 'refused' }
    const samples = observe('ws://192.168.0.56:6769', 60_000)

    expect(samples.some((s) => s.label === "Can't connect")).toBe(true)
    const after = labelsAfterFirstEscalation(samples)
    expect(after.every((s) => s.label !== 'Connecting…')).toBe(true)
  })
})
