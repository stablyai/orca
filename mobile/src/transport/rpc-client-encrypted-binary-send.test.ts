import { describe, expect, it, vi } from 'vitest'
import {
  sendEncryptedBinaryPayload,
  sendLanTerminalInputFrame
} from './rpc-client-encrypted-binary-send'
import { TerminalInputStreamRegistry } from './rpc-client-terminal-input-send'

vi.mock('./e2ee', () => ({
  encrypt: (plaintext: string) => plaintext,
  encryptBytes: (bytes: Uint8Array) => bytes
}))

describe('sendEncryptedBinaryPayload', () => {
  it('writes encrypted bytes on an open socket and reports a closed socket as failed', () => {
    const sent: Uint8Array[] = []
    const openSocket = {
      OPEN: 1,
      readyState: 1,
      send: (payload: Uint8Array) => {
        sent.push(payload)
      }
    } as unknown as WebSocket
    expect(
      sendEncryptedBinaryPayload({
        socket: openSocket,
        sharedKey: new Uint8Array(32),
        plaintext: new Uint8Array([1, 2]),
        onWriteError: () => {}
      })
    ).toBe(true)
    expect(sent).toEqual([new Uint8Array([1, 2])])

    const closedSocket = { OPEN: 1, readyState: 3, send: vi.fn() } as unknown as WebSocket
    expect(
      sendEncryptedBinaryPayload({
        socket: closedSocket,
        sharedKey: new Uint8Array(32),
        plaintext: new Uint8Array([1]),
        onWriteError: () => {}
      })
    ).toBe(false)
  })

  it('sends an Input frame for a remembered terminal stream', () => {
    const registry = new TerminalInputStreamRegistry()
    registry.remember({ terminal: 'term-1' }, 7)
    const sent: Uint8Array[] = []
    const openSocket = {
      OPEN: 1,
      readyState: 1,
      send: (payload: Uint8Array) => {
        sent.push(payload)
      }
    } as unknown as WebSocket
    expect(
      sendLanTerminalInputFrame({
        registry,
        terminal: 'term-1',
        text: 'ab',
        connected: true,
        socket: openSocket,
        sharedKey: new Uint8Array(32),
        isCurrentSocket: (socket) => socket === openSocket,
        onWriteError: () => {}
      })
    ).toBe('sent')
    expect(sent).toHaveLength(1)
  })
})
