import { describe, expect, it } from 'vitest'
import {
  encodeTerminalInputFrame,
  forgetTerminalInputStream,
  rememberTerminalInputStream,
  sendRememberedTerminalInput,
  terminalHandleFromSubscribeParams
} from './rpc-client-terminal-input-send'
import {
  decodeTerminalStreamFrame,
  decodeTerminalStreamText,
  TerminalStreamOpcode
} from './terminal-stream-protocol'

function payloadText(bytes: Uint8Array): string {
  const frame = decodeTerminalStreamFrame(bytes)
  return frame ? decodeTerminalStreamText(frame.payload) : ''
}

describe('rpc-client terminal input send', () => {
  it('encodes an Input frame for the remembered stream', () => {
    const frame = decodeTerminalStreamFrame(encodeTerminalInputFrame(9, 'hi'))
    expect(frame?.opcode).toBe(TerminalStreamOpcode.Input)
    expect(frame?.streamId).toBe(9)
    expect(frame).not.toBeNull()
    if (!frame) {
      return
    }
    expect(decodeTerminalStreamText(frame.payload)).toBe('hi')
  })

  it('sends in order and refuses a disconnected write', () => {
    const streams = new Map<string, number>()
    rememberTerminalInputStream(streams, 'term-1', 4)
    const writes: string[] = []
    expect(
      sendRememberedTerminalInput({
        streams,
        terminal: 'term-1',
        text: 'a',
        connected: true,
        sendBinary: (bytes) => {
          writes.push(payloadText(bytes))
          return true
        }
      })
    ).toBe('sent')
    expect(
      sendRememberedTerminalInput({
        streams,
        terminal: 'term-1',
        text: 'b',
        connected: true,
        sendBinary: (bytes) => {
          writes.push(payloadText(bytes))
          return true
        }
      })
    ).toBe('sent')
    expect(writes).toEqual(['a', 'b'])
    expect(
      sendRememberedTerminalInput({
        streams,
        terminal: 'term-1',
        text: 'c',
        connected: false,
        sendBinary: () => true
      })
    ).toBe('failed')
    expect(terminalHandleFromSubscribeParams({ terminal: 'term-1' })).toBe('term-1')
    forgetTerminalInputStream(streams, 'term-1', 4)
    expect(
      sendRememberedTerminalInput({
        streams,
        terminal: 'term-1',
        text: 'd',
        connected: true,
        sendBinary: () => true
      })
    ).toBe('no-stream')
  })
})
