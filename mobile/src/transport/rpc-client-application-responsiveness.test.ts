import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { classifyConnection } from './connection-health'
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
  decrypt: (raw: string) => raw.replace(/^encrypted:/, ''),
  decryptBytes: (bytes: Uint8Array) => bytes
}))

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly CONNECTING = MockWebSocket.CONNECTING
  readonly OPEN = MockWebSocket.OPEN
  readonly CLOSING = MockWebSocket.CLOSING
  readonly CLOSED = MockWebSocket.CLOSED
  readyState = MockWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  })

  constructor() {
    sockets.push(this)
  }

  send(payload: string): void {
    this.sent.push(payload)
  }

  openAndAuthenticate(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
    this.receive(JSON.stringify({ type: 'e2ee_ready' }))
    this.receive('encrypted:{"type":"e2ee_authenticated"}')
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: payload })
  }
}

const sockets: MockWebSocket[] = []
const originalWebSocket = globalThis.WebSocket

function sentRequest(socket: MockWebSocket, method: string): { id: string } {
  for (const payload of socket.sent) {
    const request = JSON.parse(payload.replace(/^encrypted:/, '')) as {
      id: string
      method: string
    }
    if (request.method === method) {
      return request
    }
  }
  throw new Error(`Request not sent: ${method}`)
}

describe('direct RPC application responsiveness', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sockets.length = 0
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.WebSocket = originalWebSocket
  })

  it('keeps application stalls latched through probes and recycles a repeated stall', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = sockets[0]!
    socket.openAndAuthenticate()
    const first = client
      .sendRequest('browser.screenshot', {}, { timeoutMs: 100, applicationHealthProbe: true })
      .catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(100)
    await expect(first).resolves.toMatchObject({
      message: 'Request timed out: browser.screenshot'
    })
    const probe = sentRequest(socket, 'status.get')
    socket.receive(`encrypted:${JSON.stringify({ id: probe.id, ok: true, result: {} })}`)
    await vi.advanceTimersByTimeAsync(0)

    const rpcUnresponsiveSince = client.getRpcUnresponsiveSince?.()
    expect(rpcUnresponsiveSince).not.toBeNull()
    expect(
      classifyConnection({
        state: client.getState(),
        reconnectAttempts: client.getReconnectAttempt(),
        lastConnectedAt: client.getLastConnectedAt(),
        rpcUnresponsiveSince
      })
    ).toMatchObject({ kind: 'warning', label: 'Desktop not responding' })

    const second = client
      .sendRequest('browser.screenshot', {}, { timeoutMs: 100, applicationHealthProbe: true })
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)

    await expect(second).resolves.toMatchObject({
      message: 'Request timed out: browser.screenshot'
    })
    expect(socket.close).toHaveBeenCalledOnce()
    expect(client.getState()).toBe('reconnecting')
    client.close()
  })

  it('confirms ordinary request timeouts without latching or recycling', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = sockets[0]!
    socket.openAndAuthenticate()
    const first = client
      .sendRequest('browser.screenshot', {}, { timeoutMs: 100 })
      .catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(100)
    await expect(first).resolves.toMatchObject({
      message: 'Request timed out: browser.screenshot'
    })
    const probe = sentRequest(socket, 'status.get')
    socket.receive(`encrypted:${JSON.stringify({ id: probe.id, ok: true, result: {} })}`)
    await vi.advanceTimersByTimeAsync(0)

    expect(client.getRpcUnresponsiveSince?.()).toBeNull()
    const second = client
      .sendRequest('browser.screenshot', {}, { timeoutMs: 100 })
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)

    await expect(second).resolves.toMatchObject({
      message: 'Request timed out: browser.screenshot'
    })
    expect(client.getRpcUnresponsiveSince?.()).toBeNull()
    expect(socket.close).not.toHaveBeenCalled()
    client.close()
  })

  it('keeps an application stall latched when only a subscription answers', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = sockets[0]!
    socket.openAndAuthenticate()
    const first = client
      .sendRequest('browser.screenshot', {}, { timeoutMs: 100, applicationHealthProbe: true })
      .catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(100)
    await expect(first).resolves.toMatchObject({
      message: 'Request timed out: browser.screenshot'
    })
    expect(client.getRpcUnresponsiveSince?.()).not.toBeNull()

    client.subscribe('terminal.subscribe', { terminal: 'term-1' }, () => {})
    const subscribe = sentRequest(socket, 'terminal.subscribe')
    socket.receive(
      `encrypted:${JSON.stringify({
        id: subscribe.id,
        ok: true,
        streaming: true,
        result: { type: 'subscribed', streamId: 42 }
      })}`
    )
    expect(client.getRpcUnresponsiveSince?.()).not.toBeNull()

    const second = client
      .sendRequest('browser.screenshot', {}, { timeoutMs: 100, applicationHealthProbe: true })
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)
    await expect(second).resolves.toMatchObject({
      message: 'Request timed out: browser.screenshot'
    })
    expect(socket.close).toHaveBeenCalledOnce()
    expect(client.getState()).toBe('reconnecting')
    client.close()
  })

  it('keeps the unresponsive verdict across a socket the control probe recycled', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    sockets[0]!.openAndAuthenticate()
    const stalled = client.sendRequest('worktree.ps', {}).catch((error: unknown) => error)

    // 20s probe interval + 8s probe timeout, with no inbound frame to extend it —
    // the recycle lands before the 30s request timeout that would otherwise latch.
    await vi.advanceTimersByTimeAsync(28_000)
    await expect(stalled).resolves.toBeInstanceOf(Error)
    expect(client.getState()).toBe('reconnecting')

    // The replacement handshake succeeds while the desktop is still wedged.
    await vi.advanceTimersByTimeAsync(600)
    sockets[1]!.openAndAuthenticate()
    expect(client.getState()).toBe('connected')

    const rpcUnresponsiveSince = client.getRpcUnresponsiveSince?.()
    expect(rpcUnresponsiveSince).not.toBeNull()
    expect(
      classifyConnection({
        state: client.getState(),
        reconnectAttempts: client.getReconnectAttempt(),
        lastConnectedAt: client.getLastConnectedAt(),
        rpcUnresponsiveSince
      })
    ).toMatchObject({ kind: 'warning', label: 'Desktop not responding' })
    client.close()
  })

  it('clears the recycled-socket verdict once the replacement answers a request', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    sockets[0]!.openAndAuthenticate()
    await vi.advanceTimersByTimeAsync(28_000)
    await vi.advanceTimersByTimeAsync(600)
    const replacement = sockets[1]!
    replacement.openAndAuthenticate()
    expect(client.getRpcUnresponsiveSince?.()).not.toBeNull()

    const recovered = client.sendRequest('worktree.ps', {})
    await vi.advanceTimersByTimeAsync(0)
    const request = sentRequest(replacement, 'worktree.ps')
    replacement.receive(`encrypted:${JSON.stringify({ id: request.id, ok: true, result: {} })}`)
    await expect(recovered).resolves.toMatchObject({ ok: true })

    expect(client.getRpcUnresponsiveSince?.()).toBeNull()
    expect(
      classifyConnection({
        state: client.getState(),
        reconnectAttempts: client.getReconnectAttempt(),
        lastConnectedAt: client.getLastConnectedAt(),
        rpcUnresponsiveSince: client.getRpcUnresponsiveSince?.()
      })
    ).toMatchObject({ kind: 'normal', label: 'Connected' })
    client.close()
  })

  it('preserves reconnect backoff across unhealthy replacement handshakes', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    sockets[0]!.openAndAuthenticate()

    await vi.advanceTimersByTimeAsync(28_000)
    await vi.advanceTimersByTimeAsync(500)
    sockets[1]!.openAndAuthenticate()
    expect(client.getReconnectAttempt()).toBe(1)

    await vi.advanceTimersByTimeAsync(28_000)
    await vi.advanceTimersByTimeAsync(999)
    expect(sockets).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(sockets).toHaveLength(3)

    sockets[2]!.openAndAuthenticate()
    const recovered = client.sendRequest('worktree.ps', {})
    await vi.advanceTimersByTimeAsync(0)
    const request = sentRequest(sockets[2]!, 'worktree.ps')
    sockets[2]!.receive(`encrypted:${JSON.stringify({ id: request.id, ok: true, result: {} })}`)
    await expect(recovered).resolves.toMatchObject({ ok: true })
    expect(client.getReconnectAttempt()).toBe(0)
    client.close()
  })
})
