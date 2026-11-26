import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from './direct-rpc-connect'
import { isRpcDeliveryUnknown } from './rpc-delivery-ambiguity'

vi.mock(
  '../encryption/direct-e2ee-framing-policy',
  () => import('./legacy-direct-framing-test-policy')
)

vi.mock('../encryption/e2ee', () => ({
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

vi.mock('../connection/mobile-runtime-capability-negotiation', () => ({
  negotiateMobileRuntimeCapabilities: (args: { onReady: () => void }) => args.onReady()
}))

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3

  readonly CONNECTING = MockWebSocket.CONNECTING
  readonly OPEN = MockWebSocket.OPEN
  readonly CLOSED = MockWebSocket.CLOSED

  readyState = MockWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  sent: string[] = []
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED
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

  drop(): void {
    this.close()
    this.onclose?.()
  }
}

const mockSockets: MockWebSocket[] = []
const originalWebSocket = globalThis.WebSocket

function readRequest(payload: string): { id: string; method: string } | null {
  const value: unknown = JSON.parse(payload.replace(/^encrypted:/, ''))
  return value &&
    typeof value === 'object' &&
    'id' in value &&
    typeof value.id === 'string' &&
    'method' in value &&
    typeof value.method === 'string'
    ? { id: value.id, method: value.method }
    : null
}

function hasSentRequest(socket: MockWebSocket, method: string): boolean {
  return socket.sent.some((payload) => readRequest(payload)?.method === method)
}

function connectAuthenticated(endpoint = 'ws://desktop.invalid'): {
  client: ReturnType<typeof connect>
  socket: MockWebSocket
} {
  const client = connect(endpoint, 'token', 'server-key')
  const socket = mockSockets[mockSockets.length - 1]!
  socket.open()
  socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
  socket.receive('encrypted:{"type":"e2ee_authenticated"}')
  return { client, socket }
}

// Written frames with lost replies must remain delivery-unknown so UI cannot claim a mutation definitely failed.
describe('mobile rpc-client socket recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockSockets.length = 0
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This socket fixture supplies the constructor, states, handlers, send and close consumed by the real client.
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.WebSocket = originalWebSocket
  })

  it('marks in-flight requests as delivery-unknown when the socket drops', async () => {
    const { client, socket } = connectAuthenticated()
    const requestError = client.sendRequest('terminal.send', { terminal: 't' }).then(
      () => null,
      (error: Error) => error
    )
    await Promise.resolve()
    expect(hasSentRequest(socket, 'terminal.send')).toBe(true)

    socket.drop()

    const error = await requestError
    expect(error).toMatchObject({ message: 'Connection interrupted' })
    expect(isRpcDeliveryUnknown(error)).toBe(true)
    client.close()
  })

  it('marks an in-flight request when the client closes before its response arrives', async () => {
    const { client, socket } = connectAuthenticated()
    const requestError = client.sendRequest('terminal.send', { terminal: 't' }).then(
      () => null,
      (error: Error) => error
    )
    await Promise.resolve()
    expect(hasSentRequest(socket, 'terminal.send')).toBe(true)

    client.close()

    const error = await requestError
    expect(error).toMatchObject({ message: 'Client closed' })
    expect(isRpcDeliveryUnknown(error)).toBe(true)
  })

  it('marks timed-out requests as delivery-unknown', async () => {
    const { client, socket } = connectAuthenticated()
    // Expire the request before the activity probe so this covers deadline ambiguity independently of socket loss.
    const requestError = client
      .sendRequest('terminal.send', { terminal: 't' }, { timeoutMs: 1_000 })
      .then(
        () => null,
        (error: Error) => error
      )
    await Promise.resolve()
    expect(hasSentRequest(socket, 'terminal.send')).toBe(true)

    await vi.advanceTimersByTimeAsync(1_000)

    const error = await requestError
    expect(error).toMatchObject({ message: 'Request timed out: terminal.send' })
    expect(isRpcDeliveryUnknown(error)).toBe(true)
    client.close()
  })

  it('marks a written request unknown when another request triggers auth recovery', async () => {
    const { client, socket } = connectAuthenticated()
    const sendError = client.sendRequest('terminal.send', { terminal: 't' }).then(
      () => null,
      (error: Error) => error
    )
    const authProbe = client.sendRequest('status.get')
    await Promise.resolve()
    expect(hasSentRequest(socket, 'terminal.send')).toBe(true)
    const probe = socket.sent.map(readRequest).find((request) => request?.method === 'status.get')
    if (!probe) {
      throw new Error('Expected the written status probe')
    }

    socket.receive(
      `encrypted:${JSON.stringify({ id: probe.id, ok: false, error: { code: 'unauthorized', message: 'Unauthorized' } })}`
    )
    await expect(authProbe).resolves.toMatchObject({
      ok: false,
      error: { code: 'unauthorized' }
    })

    const error = await sendError
    expect(isRpcDeliveryUnknown(error)).toBe(true)
    client.close()
  })

  it('does not mark requests whose frame never reached the wire', async () => {
    const { client, socket } = connectAuthenticated()
    // Simulate RN dropping onclose: the socket is dead but state is still 'connected'.
    socket.readyState = MockWebSocket.CLOSED

    const error = await client.sendRequest('terminal.send', { terminal: 't' }).then(
      () => null,
      (caught: Error) => caught
    )
    expect(error).toMatchObject({ message: 'Connection interrupted' })
    expect(isRpcDeliveryUnknown(error)).toBe(false)
    client.close()
  })

  it.each([false, true])(
    'follows up a stalled network dial while preserving an active handshake (opened: %s)',
    async (opened) => {
      const { client, socket } = connectAuthenticated()
      socket.drop()
      client.notifyForeground('network-change')
      const retrySocket = mockSockets[1]!
      await vi.advanceTimersByTimeAsync(200)
      client.notifyForeground('network-change')
      await vi.advanceTimersByTimeAsync(3_800)
      if (opened) {
        retrySocket.open()
      }
      await vi.advanceTimersByTimeAsync(199)
      expect(mockSockets).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(mockSockets).toHaveLength(opened ? 2 : 3)
      client.close()
    }
  )

  it.each([false, true])(
    'resets resume backoff only for previously reachable Tailscale hosts (reachable: %s)',
    async (previouslyConnected) => {
      const endpoint = 'ws://100.64.0.2:6768'
      const client = previouslyConnected
        ? connectAuthenticated(endpoint).client
        : connect(endpoint, 'token', 'server-key')
      mockSockets[0]!.drop()
      await vi.advanceTimersByTimeAsync(500)
      mockSockets[1]!.drop()
      expect(client.getReconnectAttempt()).toBe(2)

      if (previouslyConnected) {
        client.notifyForeground('network-change')
        await vi.advanceTimersByTimeAsync(200)
      }
      client.notifyForeground('app-resume')
      expect(mockSockets).toHaveLength(3)
      expect(client.getReconnectAttempt()).toBe(previouslyConnected ? 0 : 2)
      client.close()
    }
  )
})
