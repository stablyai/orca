import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from './rpc-client'
import {
  encodeTerminalStreamFrame,
  TerminalStreamOpcode
} from '../../../src/shared/terminal-stream-protocol'

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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies the socket constructor, states, handlers, send and close consumed by the client.
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

  it.each(['app-resume', 'network-change'] as const)(
    'ends a silent direct socket after one 4s miss on %s',
    async (reason) => {
      const client = connect('ws://desktop.invalid', 'token', 'server-key')
      const socket = sockets[0]
      if (!socket) {
        throw new Error('Expected a direct socket')
      }
      socket.authenticate()

      try {
        client.notifyForeground(reason)
        await vi.advanceTimersByTimeAsync(3_999)
        expect(client.getState()).toBe('connected')
        await vi.advanceTimersByTimeAsync(1)
        expect(socket.close).toHaveBeenCalledOnce()
        expect(client.getState()).toBe('reconnecting')
      } finally {
        client.close()
      }
    }
  )

  it('upgrades a focus probe on resume without letting repeated nudges extend the deadline', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = sockets[0]
    if (!socket) {
      throw new Error('Expected a direct socket')
    }
    socket.authenticate()

    try {
      client.notifyForeground('focus')
      await vi.advanceTimersByTimeAsync(1_000)
      client.notifyForeground('app-resume')
      await vi.advanceTimersByTimeAsync(3_000)
      client.notifyForeground('network-change')
      expect(client.getState()).toBe('connected')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(socket.close).toHaveBeenCalledOnce()
      expect(client.getState()).toBe('reconnecting')
    } finally {
      client.close()
    }
  })

  it('checks a distinct background return after a recently answered network probe', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = sockets[0]
    if (!socket) {
      throw new Error('Expected a direct socket')
    }
    socket.authenticate()

    try {
      client.notifyForeground('network-change')
      const probe: unknown = JSON.parse(socket.sent.at(-1)?.replace(/^encrypted:/, '') ?? 'null')
      if (!probe || typeof probe !== 'object' || !('id' in probe)) {
        throw new Error('Expected the network probe')
      }
      socket.onmessage?.({
        data: `encrypted:${JSON.stringify({ id: probe.id, ok: true, result: {} })}`
      })
      await vi.advanceTimersByTimeAsync(1_000)
      client.notifyForeground('app-resume')
      await vi.advanceTimersByTimeAsync(4_000)
      expect(socket.close).toHaveBeenCalledOnce()
      expect(client.getState()).toBe('reconnecting')
    } finally {
      client.close()
    }
  })

  it('ends a silent socket after one 4s miss when a caller stopped hearing back', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = sockets[0]!
    socket.authenticate()

    try {
      // Just heard from, so not suspect yet.
      const probes = () => socket.sent.filter((frame) => frame.includes('mobile-liveness-'))
      client.probeLivenessNow?.()
      await vi.advanceTimersByTimeAsync(4_000)
      expect(probes()).toHaveLength(0)

      client.probeLivenessNow?.()
      expect(probes()).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(3_999)
      expect(socket.close).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)

      expect(socket.close).toHaveBeenCalledOnce()
      expect(client.getState()).toBe('reconnecting')
    } finally {
      client.close()
    }
  })

  it('turns a tolerant probe already running into a decisive one', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = sockets[0]!
    socket.authenticate()

    try {
      client.notifyForeground('focus')
      await vi.advanceTimersByTimeAsync(4_000)
      client.probeLivenessNow?.()
      await vi.advanceTimersByTimeAsync(4_000)

      expect(socket.close).toHaveBeenCalledOnce()
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
    await vi.advanceTimersByTimeAsync(24_000)

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

  it('does not let probe replies consume the authentication retry budget', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = sockets[0]!
    socket.authenticate()

    for (let index = 0; index < 3; index++) {
      client.notifyForeground()
      const request = socket.sent
        .map((payload) => payload.replace(/^encrypted:/, ''))
        .flatMap((payload) => {
          const value: unknown = JSON.parse(payload)
          return value &&
            typeof value === 'object' &&
            'method' in value &&
            value.method === 'status.get' &&
            'id' in value &&
            typeof value.id === 'string'
            ? [{ id: value.id }]
            : []
        })
        .at(-1)
      expect(socket.sent.filter((payload) => payload.includes('status.get'))).toHaveLength(
        index + 1
      )
      if (!request) {
        throw new Error('Expected a written liveness probe')
      }
      socket.onmessage?.({
        data: `encrypted:${JSON.stringify({
          id: request.id,
          ok: false,
          error: { code: 'unauthorized', message: 'Unauthorized' }
        })}`
      })
      await vi.advanceTimersByTimeAsync(10_000)
    }

    expect(client.getState()).toBe('connected')
    expect(sockets).toHaveLength(1)
    client.close()
  })
})
