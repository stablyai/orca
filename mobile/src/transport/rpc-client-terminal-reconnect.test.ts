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
  decrypt: (raw: string) => (raw === 'undecryptable' ? null : raw.replace(/^encrypted:/, '')),
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
    this.onclose?.()
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

function authenticate(socket: MockWebSocket): void {
  socket.open()
  socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
  socket.receive('encrypted:{"type":"e2ee_authenticated"}')
}

function sentRequest(socket: MockWebSocket, method: string): { id: string } {
  for (const payload of socket.sent) {
    const decoded = JSON.parse(payload.replace(/^encrypted:/, '')) as {
      id: string
      method: string
    }
    if (decoded.method === method) {
      return { id: decoded.id }
    }
  }
  throw new Error(`Request not sent: ${method}`)
}

function sentRequests(socket: MockWebSocket, method: string): Array<{ id: string }> {
  return socket.sent
    .map(
      (payload) => JSON.parse(payload.replace(/^encrypted:/, '')) as { id: string; method: string }
    )
    .filter((request) => request.method === method)
}

function encryptedStreamingReady(id: string, streamId: number): string {
  return `encrypted:${JSON.stringify({
    id,
    ok: true,
    streaming: true,
    result: { type: 'subscribed', streamId }
  })}`
}

function unauthorizedResponsePayload(id: string): string {
  return `encrypted:${JSON.stringify({
    id,
    ok: false,
    error: { code: 'unauthorized', message: 'Unauthorized' }
  })}`
}

function encodeTerminalOutput(streamId: number, chunk: string): Uint8Array {
  return encodeTerminalStreamFrame({
    opcode: TerminalStreamOpcode.Output,
    streamId,
    seq: 1,
    payload: new TextEncoder().encode(chunk)
  })
}

describe('rpc-client terminal reconnect streams', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockSockets.length = 0
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket
    vi.useRealTimers()
  })

  it('re-subscribes active streams after auth retry without routing stale stream ids', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const first = mockSockets[0]!
    const terminalEvents: unknown[] = []
    authenticate(first)

    client.subscribe('terminal.subscribe', { terminal: 'term-1' }, (event) => {
      terminalEvents.push(event)
    })
    const initialSubscribe = sentRequest(first, 'terminal.subscribe')
    first.receive(encryptedStreamingReady(initialSubscribe.id, 76))

    const request = client.sendRequest('status.get').catch(() => undefined)
    await Promise.resolve()
    first.receive(unauthorizedResponsePayload(sentRequest(first, 'status.get').id))
    await request

    await vi.advanceTimersByTimeAsync(500)
    const second = mockSockets.at(-1)!
    authenticate(second)
    expect(sentRequests(second, 'terminal.subscribe')).toHaveLength(1)
    const resumedSubscribe = sentRequest(second, 'terminal.subscribe')
    second.receive(encryptedStreamingReady(resumedSubscribe.id, 77))
    second.receive(encodeTerminalOutput(77, 'after-reconnect'))
    second.receive(encodeTerminalOutput(76, 'stale-before-reconnect'))
    await Promise.resolve()
    await Promise.resolve()

    expect(terminalEvents).toContainEqual({
      type: 'data',
      streamId: 77,
      chunk: 'after-reconnect'
    })
    expect(terminalEvents).not.toContainEqual({
      type: 'data',
      streamId: 76,
      chunk: 'stale-before-reconnect'
    })
    client.close()
  })
})
