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

function sentRequest(socket: MockWebSocket, method: string): { id: string; params?: unknown } {
  for (const payload of socket.sent) {
    const decoded = JSON.parse(payload.replace(/^encrypted:/, '')) as {
      id: string
      method: string
      params?: unknown
    }
    if (decoded.method === method) {
      return { id: decoded.id, params: decoded.params }
    }
  }
  throw new Error(`Request not sent: ${method}`)
}

function sentRequests(
  socket: MockWebSocket,
  method: string
): Array<{ id: string; params?: unknown }> {
  const requests: Array<{ id: string; params?: unknown }> = []
  for (const payload of socket.sent) {
    const decoded = JSON.parse(payload.replace(/^encrypted:/, '')) as {
      id: string
      method: string
      params?: unknown
    }
    if (decoded.method === method) {
      requests.push({ id: decoded.id, params: decoded.params })
    }
  }
  return requests
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

function encodeTerminalOutput(streamId: number, chunk: string): Uint8Array {
  return encodeTerminalStreamFrame({
    opcode: TerminalStreamOpcode.Output,
    streamId,
    seq: 1,
    payload: new TextEncoder().encode(chunk)
  })
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

  it('closes a socket that never opens so reconnect can run', () => {
    const states: string[] = []
    const client = connect('ws://desktop.invalid', 'token', 'server-key', (state) => {
      states.push(state)
    })

    expect(client.getState()).toBe('connecting')
    expect(mockSockets).toHaveLength(1)
    mockSockets[0]!.emitCloseOnClose = false

    vi.advanceTimersByTime(12_000)

    expect(mockSockets[0]!.close).toHaveBeenCalledTimes(1)
    expect(client.getState()).toBe('reconnecting')
    expect(states).toContain('reconnecting')

    client.close()
  })

  it('ignores stale socket opens after reconnect swaps in a new socket', () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const firstSocket = mockSockets[0]!
    firstSocket.emitCloseOnClose = false

    vi.advanceTimersByTime(12_000)
    vi.advanceTimersByTime(500)

    const secondSocket = mockSockets[1]!
    expect(client.getState()).toBe('connecting')

    firstSocket.open()

    expect(client.getState()).toBe('connecting')
    expect(secondSocket.sent).toEqual([])

    vi.advanceTimersByTime(12_000)

    expect(secondSocket.close).toHaveBeenCalledTimes(1)

    client.close()
  })

  it('clears the open timeout once the socket opens and authenticates', () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!

    socket.open()
    socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
    socket.receive('encrypted:{"type":"e2ee_authenticated"}')

    expect(client.getState()).toBe('connected')

    vi.advanceTimersByTime(12_000)

    expect(socket.close).not.toHaveBeenCalled()
    expect(client.getState()).toBe('connected')

    client.close()
  })

  it('sends session tabs unsubscribe when a session tab stream is disposed', () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!

    socket.open()
    socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
    socket.receive('encrypted:{"type":"e2ee_authenticated"}')

    const unsubscribe = client.subscribe(
      'session.tabs.subscribe',
      { worktree: 'id:wt-1' },
      () => {}
    )
    unsubscribe()

    expect(
      socket.sent.some((payload) => payload.includes('"method":"session.tabs.unsubscribe"'))
    ).toBe(true)
    expect(socket.sent.some((payload) => payload.includes('"worktree":"id:wt-1"'))).toBe(true)

    client.close()
  })

  it('routes browser screencast binary frames to the browser subscriber', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    const frames: unknown[] = []

    socket.open()
    socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
    socket.receive('encrypted:{"type":"e2ee_authenticated"}')

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

    socket.receive(encodeBrowserFrame())
    await Promise.resolve()
    await Promise.resolve()

    expect(frames).toHaveLength(1)
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

    socket.open()
    socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
    socket.receive('encrypted:{"type":"e2ee_authenticated"}')

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

    socket.open()
    socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
    socket.receive('encrypted:{"type":"e2ee_authenticated"}')

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

    socket.open()
    socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
    socket.receive('encrypted:{"type":"e2ee_authenticated"}')

    expect(sentRequests(socket, 'browser.screencast')).toHaveLength(0)

    client.close()
  })

  it('replaces duplicate browser screencast subscribers and unsubscribes the old stream', () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!

    socket.open()
    socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
    socket.receive('encrypted:{"type":"e2ee_authenticated"}')

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

  it('drops old browser frames while a replacement stream is waiting for ready', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    const firstFrames: unknown[] = []
    const secondFrames: unknown[] = []

    socket.open()
    socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
    socket.receive('encrypted:{"type":"e2ee_authenticated"}')

    client.subscribe('browser.screencast', { worktree: 'id:wt-1', page: 'page-1' }, () => {}, {
      onBinaryFrame: (frame) => firstFrames.push(frame)
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
      onBinaryFrame: (frame) => secondFrames.push(frame)
    })
    const browserRequests = sentRequests(socket, 'browser.screencast')
    const second = browserRequests[browserRequests.length - 1]!
    socket.receive(encodeBrowserFrame())
    await Promise.resolve()
    await Promise.resolve()

    socket.receive(
      `encrypted:${JSON.stringify({
        id: second.id,
        ok: true,
        streaming: true,
        result: { type: 'ready', subscriptionId: 'browser-screencast:page-2:second' },
        _meta: { runtimeId: 'r1' }
      })}`
    )
    socket.receive(encodeBrowserFrame())
    await Promise.resolve()
    await Promise.resolve()

    expect(firstFrames).toHaveLength(0)
    expect(secondFrames).toHaveLength(1)

    client.close()
  })

  it('still routes terminal binary frames after browser demux is enabled', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    const events: unknown[] = []

    socket.open()
    socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
    socket.receive('encrypted:{"type":"e2ee_authenticated"}')

    client.subscribe('terminal.subscribe', { terminal: 'term-1' }, (event) => events.push(event))
    const request = sentRequest(socket, 'terminal.subscribe')
    socket.receive(
      `encrypted:${JSON.stringify({
        id: request.id,
        ok: true,
        streaming: true,
        result: { type: 'subscribed', streamId: 42 },
        _meta: { runtimeId: 'r1' }
      })}`
    )
    socket.receive(encodeTerminalOutput(42, 'hello'))
    await Promise.resolve()
    await Promise.resolve()

    expect(events).toContainEqual({ type: 'data', streamId: 42, chunk: 'hello' })

    client.close()
  })

  it('honors per-request timeout overrides', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!

    socket.open()
    socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
    socket.receive('encrypted:{"type":"e2ee_authenticated"}')

    const request = client.sendRequest(
      'speech.dictation.finish',
      { dictationId: 'd1' },
      {
        timeoutMs: 123
      }
    )
    await Promise.resolve()

    await vi.advanceTimersByTimeAsync(122)
    await expect(
      Promise.race([request.then(() => 'settled'), Promise.resolve('pending')])
    ).resolves.toBe('pending')

    await vi.advanceTimersByTimeAsync(1)
    await expect(request).rejects.toThrow('Request timed out: speech.dictation.finish')

    client.close()
  })

  it('applies per-request timeout overrides while waiting for reconnect', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!

    socket.open()
    socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
    socket.receive('encrypted:{"type":"e2ee_authenticated"}')
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

  it('rejects requests waiting for reconnect after the retry cap', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!

    socket.open()
    socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
    socket.receive('encrypted:{"type":"e2ee_authenticated"}')
    socket.close()

    const waitingRequestError = client.sendRequest('status.get').then(
      () => null,
      (error: Error) => error
    )
    await vi.runAllTimersAsync()

    expect(client.getState()).toBe('reconnecting')
    expect(client.getReconnectAttempt()).toBe(12)
    await expect(waitingRequestError).resolves.toMatchObject({
      message: 'Connection retry limit reached'
    })
    await expect(client.sendRequest('status.get')).rejects.toThrow('Connection retry limit reached')

    client.close()
  })
})
