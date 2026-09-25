import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from './rpc-client'
import { encodeTerminalStreamFrame, TerminalStreamOpcode } from './terminal-stream-protocol'

vi.mock('./e2ee', () => ({
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

vi.mock('./mobile-runtime-capability-negotiation', () => ({
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
  throwOnSend = false
  throwForMethod: string | null = null
  readonly sent: string[] = []
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  })

  constructor() {
    sockets.push(this)
  }

  send(payload: string): void {
    if (
      this.throwOnSend ||
      (this.throwForMethod && payload.includes(`"method":"${this.throwForMethod}"`))
    ) {
      throw new Error('socket send failed')
    }
    this.sent.push(payload)
  }

  authenticate(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
    this.onmessage?.({ data: JSON.stringify({ type: 'e2ee_ready' }) })
    this.onmessage?.({ data: 'encrypted:{"type":"e2ee_authenticated"}' })
  }
}

// Direct transport tolerates LIVENESS_PROBE_TIMEOUT_MS * MISSED_PROBE_LIMIT of
// control silence (8s x 3) before it gives up on a session.
const DIRECT_PROBE_BUDGET_MS = 24_000

const sockets: MockWebSocket[] = []
const originalWebSocket = globalThis.WebSocket

beforeEach(() => {
  vi.useFakeTimers()
  sockets.length = 0
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
})

afterEach(() => {
  vi.useRealTimers()
  globalThis.WebSocket = originalWebSocket
})

describe('physical session liveness', () => {
  it('recovers when the initial handshake write races socket teardown', () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = sockets[0]!
    socket.throwOnSend = true

    try {
      expect(() => socket.authenticate()).not.toThrow()
      expect(socket.close).toHaveBeenCalledOnce()
      expect(client.getState()).toBe('reconnecting')
    } finally {
      client.close()
    }
  })

  it('tolerates the first fair silent foreground-probe window', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = sockets[0]!
    socket.authenticate()

    try {
      client.notifyForeground()
      await vi.advanceTimersByTimeAsync(8_000)

      expect(socket.close).not.toHaveBeenCalled()
      expect(client.getState()).toBe('connected')
    } finally {
      client.close()
    }
  })

  // Regression (#10385): a terminal that keeps streaming must not stand in for a
  // control response. Before the fix the probe was satisfied by these frames, so a
  // desktop that had stopped answering status.get / worktree.ps stayed 'connected'
  // indefinitely and Force Reconnect could not recover it.
  it('does not count terminal binary output as a control response', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = sockets[0]!
    socket.authenticate()
    client.notifyForeground()

    await streamTerminalOutputFor(socket, DIRECT_PROBE_BUDGET_MS)

    expect(socket.close).toHaveBeenCalled()
    expect(client.getState()).toBe('reconnecting')
    client.close()
  })

  // The other side of the same rule: stream traffic no longer proves health, but a
  // link busy enough to park a control reply behind queued terminal frames must not
  // be torn down while the desktop is still answering.
  it('keeps a stream-saturated session whose control channel still answers', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = sockets[0]!
    socket.authenticate()
    client.notifyForeground()

    for (let elapsed = 0; elapsed < DIRECT_PROBE_BUDGET_MS * 2; elapsed += 1_000) {
      await streamTerminalOutputFor(socket, 1_000)
      // A reply that lands late, but inside the budget, still counts.
      answerLatestProbe(socket)
      await Promise.resolve()
    }

    expect(socket.close).not.toHaveBeenCalled()
    expect(client.getState()).toBe('connected')
    client.close()
  })

  // Hole B: the probe response is discarded by handleRpcResponse for routing, so the
  // watchdog has to be satisfied upstream of that. This proves the probe is a real
  // round trip — its own reply, with no other traffic at all, keeps the session.
  it('satisfies the liveness probe with the probe reply itself', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = sockets[0]!
    socket.authenticate()
    client.notifyForeground()

    answerLatestProbe(socket)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(DIRECT_PROBE_BUDGET_MS)

    expect(socket.close).not.toHaveBeenCalled()
    expect(client.getState()).toBe('connected')
    client.close()
  })

  // A `streaming` reply is a host-initiated subscription push, not an answer to
  // anything we sent, so it must not rescue an in-flight probe either. Without this
  // the bug survives on the text path in a narrower form.
  it('does not let a streaming subscription push satisfy an in-flight probe', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = sockets[0]!
    socket.authenticate()
    const subscription = client.subscribe('session.tabs.subscribe', {}, vi.fn())
    const streamId = sentRequests(socket).findLast(
      ({ method }) => method === 'session.tabs.subscribe'
    )?.id
    client.notifyForeground()

    for (let elapsed = 0; elapsed < DIRECT_PROBE_BUDGET_MS; elapsed += 500) {
      socket.onmessage?.({
        data: `encrypted:${JSON.stringify({
          id: streamId,
          ok: true,
          streaming: true,
          result: { type: 'data', chunk: 'push' }
        })}`
      })
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(500)
    }

    expect(socket.close).toHaveBeenCalled()
    expect(client.getState()).toBe('reconnecting')
    subscription()
    client.close()
  })

  it('turns a probe write exception into session recovery', () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = sockets[0]!
    socket.authenticate()
    socket.throwOnSend = true

    try {
      expect(() => client.notifyForeground()).not.toThrow()
      expect(socket.close).toHaveBeenCalledOnce()
      expect(client.getState()).toBe('reconnecting')
    } finally {
      client.close()
    }
  })

  it('retains every queued stream when replay write fails', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const first = sockets[0]!
    const disposeFirst = client.subscribe('terminal.subscribe', { terminal: 'term-1' }, vi.fn())
    const disposeSecond = client.subscribe('terminal.subscribe', { terminal: 'term-2' }, vi.fn())
    first.throwForMethod = 'terminal.subscribe'

    first.authenticate()
    expect(client.getState()).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(500)

    const replacement = sockets[1]!
    replacement.authenticate()
    expect(
      replacement.sent.filter((payload) => payload.includes('terminal.subscribe'))
    ).toHaveLength(2)

    disposeFirst()
    disposeSecond()
    client.close()
  })

  it('does not let probe replies consume the authentication retry budget', () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = sockets[0]!
    socket.authenticate()

    for (let index = 0; index < 3; index++) {
      client.notifyForeground()
      const request = socket.sent
        .map((payload) => payload.replace(/^encrypted:/, ''))
        .map((payload) => JSON.parse(payload) as { id?: string; method?: string })
        .findLast((payload) => payload.method === 'status.get')
      socket.onmessage?.({
        data: `encrypted:${JSON.stringify({
          id: request?.id,
          ok: false,
          error: { code: 'unauthorized', message: 'Unauthorized' }
        })}`
      })
    }

    expect(client.getState()).toBe('connected')
    expect(sockets).toHaveLength(1)
    client.close()
  })
})

function sentRequests(socket: MockWebSocket): { id?: string; method?: string }[] {
  return socket.sent
    .map((payload) => payload.replace(/^encrypted:/, ''))
    .map((payload) => JSON.parse(payload) as { id?: string; method?: string })
}

function answerLatestProbe(socket: MockWebSocket): void {
  const probe = sentRequests(socket).findLast(({ method }) => method === 'status.get')
  if (!probe) {
    return
  }
  socket.onmessage?.({
    data: `encrypted:${JSON.stringify({ id: probe.id, ok: true, result: {} })}`
  })
}

async function streamTerminalOutputFor(socket: MockWebSocket, durationMs: number): Promise<void> {
  for (let elapsed = 0; elapsed < durationMs; elapsed += 500) {
    socket.onmessage?.({
      data: encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        streamId: 42,
        seq: elapsed,
        payload: new TextEncoder().encode('hello')
      })
    })
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(500)
  }
}
