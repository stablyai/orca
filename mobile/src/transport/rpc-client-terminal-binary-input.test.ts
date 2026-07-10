import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from './rpc-client'
import { TerminalStreamOpcode } from './terminal-stream-protocol'
import {
  MockWebSocket,
  authenticateMockSocket,
  mockSockets,
  receiveTerminalSubscribed,
  sentRequest,
  subscribeTerminalStream
} from './rpc-client-test-mock-websocket'

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
  decryptBytes: (bytes: Uint8Array) => bytes,
  encryptBytes: (bytes: Uint8Array) => bytes
}))

const originalWebSocket = globalThis.WebSocket

function lastBinaryFrameStreamId(socket: MockWebSocket): number {
  const lastSent = socket.sent[socket.sent.length - 1]!
  expect(typeof lastSent).not.toBe('string')
  const frame = new Uint8Array(lastSent as ArrayBuffer)
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(4, true)
}

describe('mobile rpc-client terminal binary input', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockSockets.length = 0
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.WebSocket = originalWebSocket
  })

  it('sends terminal binary input as an encrypted Input frame on the subscribed stream', () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    authenticateMockSocket(socket)
    subscribeTerminalStream(client, socket, 'term-1', 42)

    expect(client.sendTerminalBinaryInput('term-1', new TextEncoder().encode('ab'))).toBe(true)

    const lastSent = socket.sent[socket.sent.length - 1]!
    expect(typeof lastSent).not.toBe('string')
    const frame = new Uint8Array(lastSent as ArrayBuffer)
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
    expect(view.getUint8(0)).toBe(0x74)
    expect(view.getUint8(2)).toBe(TerminalStreamOpcode.Input)
    expect(view.getUint32(4, true)).toBe(42)
    expect(new TextDecoder().decode(frame.slice(16))).toBe('ab')

    client.close()
  })

  it('refuses terminal binary input for a terminal that was never subscribed', () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    authenticateMockSocket(socket)

    const sentBefore = socket.sent.length
    expect(client.sendTerminalBinaryInput('term-1', new TextEncoder().encode('ab'))).toBe(false)
    expect(socket.sent.length).toBe(sentBefore)

    client.close()
  })

  it('refuses terminal binary input when the host subscribes without a streamId (older host)', () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    authenticateMockSocket(socket)
    // Why: hosts predating the binary stream protocol emit subscribed with no
    // streamId, so nothing registers and input must stay on the RPC path.
    subscribeTerminalStream(client, socket, 'term-1')

    const sentBefore = socket.sent.length
    expect(client.sendTerminalBinaryInput('term-1', new TextEncoder().encode('ab'))).toBe(false)
    expect(socket.sent.length).toBe(sentBefore)

    client.close()
  })

  it('refuses terminal binary input after reconnect until the stream is resubscribed', () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const firstSocket = mockSockets[0]!
    authenticateMockSocket(firstSocket)
    subscribeTerminalStream(client, firstSocket, 'term-1', 42)
    expect(client.sendTerminalBinaryInput('term-1', new TextEncoder().encode('a'))).toBe(true)
    expect(lastBinaryFrameStreamId(firstSocket)).toBe(42)

    firstSocket.close()
    vi.advanceTimersByTime(500)
    const secondSocket = mockSockets[1]!
    authenticateMockSocket(secondSocket)

    // Why: reconnect clears the routing maps; sends must fail (→ RPC fallback)
    // until the replayed subscribe delivers a fresh streamId.
    expect(client.sendTerminalBinaryInput('term-1', new TextEncoder().encode('b'))).toBe(false)

    const replay = sentRequest(secondSocket, 'terminal.subscribe')
    receiveTerminalSubscribed(secondSocket, replay.id, 43)
    expect(client.sendTerminalBinaryInput('term-1', new TextEncoder().encode('c'))).toBe(true)
    expect(lastBinaryFrameStreamId(secondSocket)).toBe(43)

    client.close()
  })
})
