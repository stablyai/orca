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

  it('counts authenticated terminal binary output as liveness', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = sockets[0]!
    socket.authenticate()
    client.notifyForeground()
    socket.onmessage?.({
      data: encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        streamId: 42,
        seq: 1,
        payload: new TextEncoder().encode('hello')
      })
    })
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(8_000)

    expect(socket.close).not.toHaveBeenCalled()
    expect(client.getState()).toBe('connected')
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
