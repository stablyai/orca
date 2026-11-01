import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from './rpc-client'
import { recordSocketDeadlineAppState } from './socket-deadline-clock'

// A host kept paired while offline must not be redialed on every resume or network change (#13354).

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

  constructor(readonly endpoint: string) {
    sockets.push(this)
  }

  send(): void {}

  close(): void {
    if (this.readyState === MockWebSocket.CLOSED) {
      return
    }
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({ code: 1006, wasClean: false })
  }

  authenticate(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
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

const ENDPOINT = 'ws://100.84.12.9:6769'
// 360.5s of backoff plus 13 × 12s connect timeouts reach the retry limit and arm the first slow retry.
const PAST_RETRY_LIMIT_MS = 520_000

describe('revival nudges toward a failing host', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    recordSocketDeadlineAppState('active')
    sockets.length = 0
    vi.stubGlobal('WebSocket', MockWebSocket)
  })

  afterEach(() => {
    recordSocketDeadlineAppState('active')
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('pulls one attempt forward without resetting escalation until a session authenticates', async () => {
    const client = connect(ENDPOINT, 'token', 'server-key')
    latest().close()
    for (const delayMs of [500, 1_000, 2_000]) {
      await vi.advanceTimersByTimeAsync(delayMs)
      latest().close()
    }
    expect(client.getReconnectAttempt()).toBe(4)

    client.notifyForeground('network-change')
    expect(sockets).toHaveLength(5)
    expect(client.getReconnectAttempt()).toBe(4)
    latest().close()

    // The refused nudge dial continues at the fifth backoff step instead of restarting at 500ms.
    await vi.advanceTimersByTimeAsync(7_999)
    expect(sockets).toHaveLength(5)
    await vi.advanceTimersByTimeAsync(1)
    expect(sockets).toHaveLength(6)

    latest().authenticate()
    expect(client.getReconnectAttempt()).toBe(0)
    latest().close()
    await vi.advanceTimersByTimeAsync(500)
    expect(sockets).toHaveLength(7)

    client.close()
  })

  it('ignores nudges for a never-connected host past the limit and slows its retries', async () => {
    const client = connect(ENDPOINT, 'token', 'server-key')
    await vi.advanceTimersByTimeAsync(PAST_RETRY_LIMIT_MS)
    expect(client.getReconnectAttempt()).toBe(12)
    const dials = sockets.length

    client.notifyForeground('app-resume')
    client.notifyForeground('network-change')
    await vi.advanceTimersByTimeAsync(90_000)
    expect(sockets).toHaveLength(dials)

    // The slow retry armed at 516.5s dials five minutes later.
    await vi.advanceTimersByTimeAsync(210_000)
    expect(sockets).toHaveLength(dials + 1)

    recordSocketDeadlineAppState('background')
    await vi.advanceTimersByTimeAsync(600_000)
    expect(sockets).toHaveLength(dials + 1)

    recordSocketDeadlineAppState('active')
    client.notifyForeground('app-resume')
    expect(sockets).toHaveLength(dials + 1)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(sockets).toHaveLength(dials + 2)

    client.close()
  })

  it('arms the slow retry on the failure that uses up the limit', async () => {
    const client = connect(ENDPOINT, 'token', 'server-key')
    while (client.getReconnectAttempt() < 12) {
      await vi.advanceTimersByTimeAsync(1_000)
    }
    const dials = sockets.length

    // A fast 60s retry armed here would keep re-arming in the background and dial once the app returns.
    recordSocketDeadlineAppState('background')
    await vi.advanceTimersByTimeAsync(130_000)
    recordSocketDeadlineAppState('active')
    await vi.advanceTimersByTimeAsync(100_000)
    expect(sockets).toHaveLength(dials)

    await vi.advanceTimersByTimeAsync(80_000)
    expect(sockets).toHaveLength(dials + 1)

    client.close()
  })

  it('dials at once on the fast schedule when a manual retry replaces a dormant client', async () => {
    const dormant = connect(ENDPOINT, 'token', 'server-key')
    await vi.advanceTimersByTimeAsync(PAST_RETRY_LIMIT_MS)
    dormant.close()
    const dials = sockets.length

    // Manual Retry and re-pairing close the client and open a new one for the host.
    const retried = connect(ENDPOINT, 'token', 'server-key')
    expect(sockets).toHaveLength(dials + 1)
    latest().close()
    await vi.advanceTimersByTimeAsync(500)
    expect(sockets).toHaveLength(dials + 2)

    retried.close()
  })
})
