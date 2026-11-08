import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from './rpc-client'

vi.mock(
  './encryption/direct-e2ee-framing-policy',
  () => import('./legacy-direct-framing-test-policy')
)

vi.mock('./encryption/e2ee', () => ({
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
vi.mock('./mobile-runtime-capability-negotiation', () => ({
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

type SentRpcRequest = { id: string; method: string; params?: unknown }

function sentRequest(socket: MockWebSocket, method: string): SentRpcRequest {
  const request = sentRequests(socket, method)[0]
  if (request) {
    return request
  }
  throw new Error(`Request not sent: ${method}`)
}

function sentRequests(socket: MockWebSocket, method: string): SentRpcRequest[] {
  return socket.sent
    .map((payload) => {
      const request: unknown = JSON.parse(payload.replace(/^encrypted:/, ''))
      if (
        !request ||
        typeof request !== 'object' ||
        !('id' in request) ||
        typeof request.id !== 'string' ||
        !('method' in request) ||
        typeof request.method !== 'string'
      ) {
        return null
      }
      return request
    })
    .filter((request): request is SentRpcRequest => request !== null && request.method === method)
}

function encodeBrowserFrame(): Uint8Array {
  const metadata = new TextEncoder().encode(JSON.stringify({ deviceWidth: 800, deviceHeight: 600 }))
  const image = new Uint8Array([1, 2, 3, 4])
  const out = new Uint8Array(16 + metadata.byteLength + image.byteLength)
  const view = new DataView(out.buffer)
  view.setUint8(0, 0x62)
  view.setUint8(1, 1)
  view.setUint8(2, 1)
  view.setUint8(3, 1)
  view.setUint32(4, 7, true)
  view.setUint32(8, metadata.byteLength, true)
  view.setUint32(12, 0, true)
  out.set(metadata, 16)
  out.set(image, 16 + metadata.byteLength)
  return out
}

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

  it('sends session tabs unsubscribe when a session tab stream is disposed', () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!

    openAndAuthenticate(socket)

    const unsubscribe = client.subscribe(
      'session.tabs.subscribe',
      { worktree: 'id:wt-1' },
      () => {}
    )
    const request = sentRequest(socket, 'session.tabs.subscribe')
    socket.receive(
      `encrypted:${JSON.stringify({
        id: request.id,
        ok: true,
        streaming: true,
        result: { type: 'snapshot', worktree: 'id:wt-1', tabs: [] },
        _meta: { runtimeId: 'r1' }
      })}`
    )
    unsubscribe()

    expect(sentRequests(socket, 'session.tabs.unsubscribe')).toEqual([
      expect.objectContaining({ params: { worktree: 'id:wt-1', subscriptionId: request.id } })
    ])

    client.close()
  })

  it('routes browser screencast binary frames to the browser subscriber', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    const frames: unknown[] = []

    openAndAuthenticate(socket)

    const unsubscribe = client.subscribe(
      'browser.screencast',
      { worktree: 'id:wt-1', page: 'page-1' },
      () => {},
      { onBinaryFrame: (frame) => frames.push(frame) }
    )
    const request = sentRequest(socket, 'browser.screencast')
    socket.receive(
      `encrypted:${JSON.stringify({
        id: request.id,
        ok: true,
        streaming: true,
        result: { type: 'ready', subscriptionId: 'browser-screencast:page-1:test' },
        _meta: { runtimeId: 'r1' }
      })}`
    )

    client.notifyForeground()
    socket.receive(encodeBrowserFrame())
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(8_000)

    expect(frames).toHaveLength(1)
    expect(socket.close).not.toHaveBeenCalled()
    expect(frames[0]).toMatchObject({
      seq: 7,
      format: 'jpeg',
      metadata: { deviceWidth: 800, deviceHeight: 600 }
    })

    unsubscribe()
    client.close()
  })

  it('sends browser screencast unsubscribe after ready even when disposed early', () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!

    openAndAuthenticate(socket)

    const unsubscribe = client.subscribe(
      'browser.screencast',
      { worktree: 'id:wt-1', page: 'page-1' },
      () => {},
      { onBinaryFrame: () => {} }
    )
    const request = sentRequest(socket, 'browser.screencast')
    unsubscribe()
    socket.receive(
      `encrypted:${JSON.stringify({
        id: request.id,
        ok: true,
        streaming: true,
        result: { type: 'ready', subscriptionId: 'browser-screencast:page-1:test' },
        _meta: { runtimeId: 'r1' }
      })}`
    )

    expect(
      socket.sent.some(
        (payload) =>
          payload.includes('"method":"browser.screencast.unsubscribe"') &&
          payload.includes('"subscriptionId":"browser-screencast:page-1:test"')
      )
    ).toBe(true)

    client.close()
  })

  it('reports rejected browser screencast subscribes and drops the stale frame sink', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    const events: unknown[] = []
    const frames: unknown[] = []

    openAndAuthenticate(socket)

    client.subscribe(
      'browser.screencast',
      { worktree: 'id:wt-1', page: 'page-1' },
      (event) => events.push(event),
      { onBinaryFrame: (frame) => frames.push(frame) }
    )
    const request = sentRequest(socket, 'browser.screencast')
    socket.receive(
      `encrypted:${JSON.stringify({
        id: request.id,
        ok: false,
        error: { code: 'forbidden', message: 'not allowed' },
        _meta: { runtimeId: 'r1' }
      })}`
    )

    socket.receive(encodeBrowserFrame())
    await Promise.resolve()
    await Promise.resolve()

    expect(events).toEqual([
      {
        type: 'error',
        message: 'not allowed',
        error: { code: 'forbidden', message: 'not allowed' }
      }
    ])
    expect(frames).toHaveLength(0)

    client.close()
  })

  it('deletes queued browser screencast subscribes when disposed before connect', () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!

    const unsubscribe = client.subscribe(
      'browser.screencast',
      { worktree: 'id:wt-1', page: 'page-1' },
      () => {},
      { onBinaryFrame: () => {} }
    )
    unsubscribe()

    openAndAuthenticate(socket)

    expect(sentRequests(socket, 'browser.screencast')).toHaveLength(0)

    client.close()
  })

  it('replaces duplicate browser screencast subscribers and unsubscribes the old stream', () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!

    openAndAuthenticate(socket)

    client.subscribe('browser.screencast', { worktree: 'id:wt-1', page: 'page-1' }, () => {}, {
      onBinaryFrame: () => {}
    })
    const first = sentRequest(socket, 'browser.screencast')
    socket.receive(
      `encrypted:${JSON.stringify({
        id: first.id,
        ok: true,
        streaming: true,
        result: { type: 'ready', subscriptionId: 'browser-screencast:page-1:first' },
        _meta: { runtimeId: 'r1' }
      })}`
    )

    client.subscribe('browser.screencast', { worktree: 'id:wt-1', page: 'page-2' }, () => {}, {
      onBinaryFrame: () => {}
    })

    expect(sentRequests(socket, 'browser.screencast')).toHaveLength(2)
    expect(
      socket.sent.some(
        (payload) =>
          payload.includes('"method":"browser.screencast.unsubscribe"') &&
          payload.includes('"subscriptionId":"browser-screencast:page-1:first"')
      )
    ).toBe(true)

    client.close()
  })

  it('replays terminal subscribe with the latest viewport after reconnect', () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const firstSocket = mockSockets[0]!

    openAndAuthenticate(firstSocket)

    client.subscribe(
      'terminal.subscribe',
      {
        terminal: 'term-1',
        client: { id: 'phone-1', type: 'mobile' },
        viewport: { cols: 45, rows: 20 }
      },
      () => {}
    )
    expect(sentRequest(firstSocket, 'terminal.subscribe').params).toMatchObject({
      viewport: { cols: 45, rows: 20 }
    })

    client.updateTerminalSubscriptionViewport('term-1', { cols: 60, rows: 24 })
    firstSocket.close()
    vi.advanceTimersByTime(500)
    const secondSocket = mockSockets[1]!
    openAndAuthenticate(secondSocket)

    expect(sentRequest(secondSocket, 'terminal.subscribe').params).toMatchObject({
      viewport: { cols: 60, rows: 24 }
    })

    client.close()
  })

  it('applies per-request timeout overrides while waiting for reconnect', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!

    openAndAuthenticate(socket)
    socket.close()

    const request = client.sendRequest(
      'speech.dictation.finish',
      { dictationId: 'd1' },
      {
        timeoutMs: 123
      }
    )
    let requestOutcome = 'pending'
    request.then(
      () => {
        requestOutcome = 'resolved'
      },
      (error: Error) => {
        requestOutcome = error.message
      }
    )

    try {
      await vi.advanceTimersByTimeAsync(122)
      await Promise.resolve()
      expect(requestOutcome).toBe('pending')

      await vi.advanceTimersByTimeAsync(1)
      await Promise.resolve()
      expect(requestOutcome).toBe('Timed out while connecting to the remote Orca runtime.')
    } finally {
      client.close()
      await request.catch(() => undefined)
    }
  })

  // Foreground recovery must heal Android sessions left half-open after suspension (#5049).
  describe('foreground recovery', () => {
    function connectAuthenticated() {
      const client = connect('ws://desktop.invalid', 'token', 'server-key')
      const socket = mockSockets[0]!
      openAndAuthenticate(socket)
      return { client, socket }
    }

    // Pass the fast-attempt cap: 360.5s backoff + 13 × 12s connect timeouts, leaving the first trickle timer armed.

    it('keeps a healthy connection when the foreground probe is answered', async () => {
      const { client, socket } = connectAuthenticated()

      client.notifyForeground()
      const probe = sentRequest(socket, 'status.get')
      socket.receive(`encrypted:${JSON.stringify({ id: probe.id, ok: true, result: {} })}`)

      await vi.advanceTimersByTimeAsync(24_000)
      expect(socket.close).not.toHaveBeenCalled()
      expect(client.getState()).toBe('connected')

      client.close()
    })
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
