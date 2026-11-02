import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from './rpc-client'

vi.mock('./direct-e2ee-framing-policy', () => import('./legacy-direct-framing-test-policy'))

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
    if (this.readyState === MockWebSocket.CLOSED) {
      return
    }
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
    this.receive(JSON.stringify({ type: 'e2ee_ready' }))
    this.receive('encrypted:{"type":"e2ee_authenticated"}')
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: payload })
  }
}

const mockSockets: MockWebSocket[] = []
const originalWebSocket = globalThis.WebSocket

// Observe rejection state without awaiting a promise under fake timers.
function track(request: Promise<unknown>): { read: () => string } {
  let outcome = 'pending'
  request.then(
    () => {
      outcome = 'resolved'
    },
    (error: Error) => {
      outcome = error.message
    }
  )
  return { read: () => outcome }
}

describe('mobile rpc-client request deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockSockets.length = 0
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The socket fixture provides the constructor, states, handlers, send and close used by the real client.
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.WebSocket = originalWebSocket
  })

  it('spends one deadline across connect-wait and request, not one each', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    socket.open()
    socket.close()

    const request = client.sendRequest(
      'terminal.send',
      { terminal: 't1', text: 'hi' },
      { timeoutMs: 5_000, budgetSpansConnect: true }
    )
    const outcome = track(request)

    try {
      await vi.advanceTimersByTimeAsync(500)
      mockSockets[1]!.open()
      await vi.advanceTimersByTimeAsync(0)
      expectRequestSent(mockSockets[1]!, 'terminal.send', { terminal: 't1', text: 'hi' })

      await vi.advanceTimersByTimeAsync(4_499)
      expect(outcome.read()).toBe('pending')

      await vi.advanceTimersByTimeAsync(1)
      expect(outcome.read()).toBe('Request timed out: terminal.send')
    } finally {
      client.close()
      await request.catch(() => undefined)
    }
  })

  it('leaves a caller that did not opt in on the post-connect clock', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    socket.open()
    socket.close()

    // A pre-existing caller's budget was sized against the request phase alone;
    // the connect wait must not eat into it.
    const request = client.sendRequest(
      'speech.dictation.finish',
      { dictationId: 'd1' },
      { timeoutMs: 5_000 }
    )
    const outcome = track(request)

    try {
      await vi.advanceTimersByTimeAsync(500)
      mockSockets[1]!.open()
      await vi.advanceTimersByTimeAsync(0)
      expectRequestSent(mockSockets[1]!, 'speech.dictation.finish', { dictationId: 'd1' })

      await vi.advanceTimersByTimeAsync(4_999)
      expect(outcome.read()).toBe('pending')

      await vi.advanceTimersByTimeAsync(1)
      expect(outcome.read()).toBe('Request timed out: speech.dictation.finish')
    } finally {
      client.close()
      await request.catch(() => undefined)
    }
  })

  it('never floors a sub-second request timeout above what the caller asked for', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    mockSockets[0]!.open()

    const request = client.sendRequest(
      'terminal.send',
      { terminal: 't1', text: 'hi' },
      { timeoutMs: 400, budgetSpansConnect: true }
    )
    const outcome = track(request)

    try {
      await vi.advanceTimersByTimeAsync(0)
      expectRequestSent(mockSockets[0]!, 'terminal.send', { terminal: 't1', text: 'hi' })
      await vi.advanceTimersByTimeAsync(399)
      expect(outcome.read()).toBe('pending')
      await vi.advanceTimersByTimeAsync(1)
      expect(outcome.read()).toBe('Request timed out: terminal.send')
    } finally {
      client.close()
      await request.catch(() => undefined)
    }
  })
})

function expectRequestSent(socket: MockWebSocket, method: string, params: unknown): void {
  const frames = socket.sent
    .filter((frame) => frame.startsWith('encrypted:'))
    .map((frame) => JSON.parse(frame.slice('encrypted:'.length)))
  expect(frames).toContainEqual({
    id: expect.stringMatching(/^rpc-/),
    deviceToken: 'token',
    method,
    params
  })
}
