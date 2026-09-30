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

  it('lets terminal output defer the idle probe', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = sockets[0]!
    socket.authenticate()

    try {
      for (let seq = 1; seq <= 12; seq += 1) {
        socket.onmessage?.({ data: terminalOutputFrame(seq) })
        await vi.advanceTimersByTimeAsync(5_000)
      }

      expect(sentProbeIds(socket)).toEqual([])
      expect(client.getState()).toBe('connected')
    } finally {
      client.close()
    }
  })

  it('does not let terminal output satisfy an outstanding probe', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = sockets[0]!
    socket.authenticate()

    try {
      client.notifyForeground()
      for (let seq = 1; seq <= 15; seq += 1) {
        socket.onmessage?.({ data: terminalOutputFrame(seq) })
        await vi.advanceTimersByTimeAsync(2_000)
      }

      expect(socket.close).toHaveBeenCalledOnce()
    } finally {
      client.close()
    }
  })

  it('settles an outstanding probe on its reply', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = sockets[0]!
    socket.authenticate()

    try {
      client.notifyForeground()
      const [probeId] = sentProbeIds(socket)
      socket.onmessage?.({
        data: `encrypted:${JSON.stringify({ id: probeId, ok: true, result: {}, _meta: {} })}`
      })
      await vi.advanceTimersByTimeAsync(24_000)

      expect(socket.close).not.toHaveBeenCalled()
      expect(client.getState()).toBe('connected')
    } finally {
      client.close()
    }
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

function terminalOutputFrame(seq: number): Uint8Array {
  return encodeTerminalStreamFrame({
    opcode: TerminalStreamOpcode.Output,
    streamId: 42,
    seq,
    payload: new TextEncoder().encode('hello')
  })
}

function sentProbeIds(socket: MockWebSocket): string[] {
  return socket.sent
    .map(
      (payload) =>
        JSON.parse(payload.replace(/^encrypted:/, '')) as { id?: string; method?: string }
    )
    .filter((request) => request.method === 'status.get')
    .map((request) => request.id ?? '')
}
