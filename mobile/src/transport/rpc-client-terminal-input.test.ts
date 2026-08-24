import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from './rpc-client'
import {
  decodeTerminalStreamFrame,
  decodeTerminalStreamText,
  TerminalStreamOpcode
} from './terminal-stream-protocol'

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
  encryptBytes: (bytes: Uint8Array) => bytes,
  decryptBytes: (bytes: Uint8Array) => bytes
}))

class MockWebSocket {
  static OPEN = 1
  readonly OPEN = MockWebSocket.OPEN
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  sent: (string | Uint8Array)[] = []
  close = vi.fn(() => {
    this.readyState = 3
    this.onclose?.()
  })

  constructor(readonly endpoint: string) {
    mockSockets.push(this)
  }

  send(payload: string | Uint8Array): void {
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
    if (typeof payload !== 'string') {
      continue
    }
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

describe('rpc-client terminal input frames', () => {
  beforeEach(() => {
    mockSockets.length = 0
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket
  })

  it('writes live terminal input as a stream frame without waiting for an RPC response', () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    authenticate(socket)
    client.subscribe('terminal.subscribe', { terminal: 'term-1' }, () => {})
    socket.receive(
      `encrypted:${JSON.stringify({
        id: sentRequest(socket, 'terminal.subscribe').id,
        ok: true,
        streaming: true,
        result: { type: 'subscribed', streamId: 42 }
      })}`
    )

    expect(client.sendTerminalInput?.('term-1', 'ab')).toBe('sent')
    expect(client.sendTerminalInput?.('term-1', 'c')).toBe('sent')
    const inputFrames = socket.sent
      .filter((payload): payload is Uint8Array => payload instanceof Uint8Array)
      .map((payload) => decodeTerminalStreamFrame(payload))
      .filter(
        (frame): frame is NonNullable<typeof frame> => frame?.opcode === TerminalStreamOpcode.Input
      )
    expect(inputFrames.map((frame) => decodeTerminalStreamText(frame.payload))).toEqual(['ab', 'c'])
    expect(
      socket.sent.some(
        (payload) => typeof payload === 'string' && payload.includes('"method":"terminal.send"')
      )
    ).toBe(false)
    client.close()
  })

  it('falls back to no-stream before subscribe and fails after disconnect', () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    authenticate(socket)
    expect(client.sendTerminalInput?.('term-1', 'a')).toBe('no-stream')
    client.subscribe('terminal.subscribe', { terminal: 'term-1' }, () => {})
    socket.receive(
      `encrypted:${JSON.stringify({
        id: sentRequest(socket, 'terminal.subscribe').id,
        ok: true,
        streaming: true,
        result: { type: 'subscribed', streamId: 42 }
      })}`
    )
    client.close()
    expect(client.sendTerminalInput?.('term-1', 'a')).toBe('failed')
  })
})
