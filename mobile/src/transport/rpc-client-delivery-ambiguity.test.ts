import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from './rpc-client'
import { isRpcDeliveryUnknown } from './rpc-delivery-ambiguity'

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

function hasSentRequest(socket: MockWebSocket, method: string): boolean {
  return socket.sent.some(
    (payload) =>
      (JSON.parse(payload.replace(/^encrypted:/, '')) as { method: string }).method === method
  )
}

function connectAuthenticated(): { client: ReturnType<typeof connect>; socket: MockWebSocket } {
  const client = connect('ws://desktop.invalid', 'token', 'server-key')
  const socket = mockSockets[0]!
  socket.open()
  socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
  socket.receive('encrypted:{"type":"e2ee_authenticated"}')
  return { client, socket }
}

// Callers presenting send failures must be able to tell "the host never got the
// frame" from "the frame was written and only the response is missing" — the
// latter must not be reported to the user as a definite failure.
describe('mobile rpc-client delivery ambiguity marking', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockSockets.length = 0
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
    // Short override so the request times out before the activity probe
    // declares the whole socket dead (which is the drop case above).
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
})
