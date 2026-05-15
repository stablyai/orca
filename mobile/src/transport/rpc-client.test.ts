import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  decrypt: (raw: string) => raw.replace(/^encrypted:/, '')
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
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  emitCloseOnClose = true
  sent: string[] = []
  close = vi.fn(() => {
    if (this.readyState === MockWebSocket.CLOSED) return
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

  receive(payload: string): void {
    this.onmessage?.({ data: payload })
  }
}

const mockSockets: MockWebSocket[] = []
const originalWebSocket = globalThis.WebSocket

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
})
