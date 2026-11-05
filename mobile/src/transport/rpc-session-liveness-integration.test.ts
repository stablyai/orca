import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from './rpc-client'
import {
  encodeTerminalStreamFrame,
  TerminalStreamOpcode
} from '../../../src/shared/terminal/stream/terminal-stream-protocol'

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

function lastRequestId(socket: MockWebSocket): string {
  const value: unknown = JSON.parse(socket.sent.at(-1)?.replace(/^encrypted:/, '') ?? 'null')
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') {
    throw new Error('Expected a written request')
  }
  return value.id
}

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

  it('reconnects when control probes stall while terminal and browser traffic continues', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = sockets[0]!
    socket.authenticate()
    client.notifyForeground()
    for (let seq = 1; seq <= 3; seq++) {
      await vi.advanceTimersByTimeAsync(7_999)
      socket.onmessage?.({
        data: encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Output,
          streamId: 42,
          seq,
          payload: new TextEncoder().encode('hello')
        })
      })
      socket.onmessage?.({
        data: 'encrypted:{"id":"browser-stream","ok":true,"result":{"frame":"data"}}'
      })
      await vi.advanceTimersByTimeAsync(1)
    }

    expect(socket.close).toHaveBeenCalledOnce()
    expect(client.getState()).toBe('reconnecting')
    client.close()
  })

  it('ignores superseded probes and unrelated RPC replies during a control check', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = sockets[0]!
    socket.authenticate()
    const request = client.sendRequest('status.get')
    await vi.advanceTimersByTimeAsync(0)
    const requestId = lastRequestId(socket)
    client.notifyForeground('focus')
    const firstProbe = lastRequestId(socket)
    await vi.advanceTimersByTimeAsync(8_000)
    await vi.advanceTimersByTimeAsync(7_000)
    for (const id of [firstProbe, requestId]) {
      socket.onmessage?.({ data: `encrypted:${JSON.stringify({ id, ok: true, result: {} })}` })
    }
    expect((await request).ok).toBe(true)
    await vi.advanceTimersByTimeAsync(9_000)
    expect(client.getState()).toBe('reconnecting')
    client.close()
  })

  it('does not let probe replies consume the authentication retry budget', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = sockets[0]!
    socket.authenticate()

    for (let index = 0; index < 3; index++) {
      client.notifyForeground()
      const id = lastRequestId(socket)
      expect(socket.sent.filter((payload) => payload.includes('status.get'))).toHaveLength(
        index + 1
      )
      socket.onmessage?.({
        data: `encrypted:${JSON.stringify({
          id,
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
