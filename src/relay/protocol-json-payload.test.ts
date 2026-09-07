import { describe, expect, it } from 'vitest'
import * as mainProtocol from '../main/ssh/relay-protocol'
import {
  HEADER_LENGTH,
  MAX_MESSAGE_SIZE,
  MessageType,
  encodeFrame,
  encodeJsonRpcFrame,
  encodePreparedJsonRpcFrame,
  prepareJsonRpcPayload,
  type JsonRpcNotification
} from './protocol'

describe('prepared relay JSON payload framing', () => {
  it('is byte-equivalent to direct composition for every header field', () => {
    const message: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'pty.data',
      params: { id: 'pty-1', data: 'héllo "𝄞"\\\n\uD800', seq: 42 }
    }
    const payload = Buffer.from(JSON.stringify(message), 'utf8')
    const relayPrepared = prepareJsonRpcPayload(message)
    const mainPrepared = mainProtocol.prepareJsonRpcPayload(message)

    for (const [id, ack] of [
      [0, 0],
      [19, 7],
      [0xffffffff, 0xfffffffe]
    ]) {
      const reference = encodeFrame(MessageType.Regular, id, ack, payload)
      expect(encodePreparedJsonRpcFrame(relayPrepared, id, ack).equals(reference)).toBe(true)
      expect(encodeJsonRpcFrame(message, id, ack).equals(reference)).toBe(true)
      expect(mainProtocol.encodePreparedJsonRpcFrame(mainPrepared, id, ack).equals(reference)).toBe(
        true
      )
      expect(mainProtocol.encodeJsonRpcFrame(message, id, ack).equals(reference)).toBe(true)
    }
  })

  it('accepts the exact payload maximum and rejects one byte more', () => {
    const base: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'x',
      params: { data: '' }
    }
    const overhead = Buffer.byteLength(JSON.stringify(base))
    const exact = { ...base, params: { data: 'a'.repeat(MAX_MESSAGE_SIZE - overhead) } }
    const oversized = { ...base, params: { data: 'a'.repeat(MAX_MESSAGE_SIZE - overhead + 1) } }

    const relayPrepared = prepareJsonRpcPayload(exact)
    const mainPrepared = mainProtocol.prepareJsonRpcPayload(exact)
    expect(relayPrepared.byteLength).toBe(MAX_MESSAGE_SIZE)
    expect(mainPrepared.byteLength).toBe(MAX_MESSAGE_SIZE)
    expect(encodePreparedJsonRpcFrame(relayPrepared, 1, 0)).toHaveLength(
      HEADER_LENGTH + MAX_MESSAGE_SIZE
    )
    expect(() => prepareJsonRpcPayload(oversized)).toThrow('Message too large')
    expect(() => mainProtocol.prepareJsonRpcPayload(oversized)).toThrow('Message too large')
    expect(() => encodeJsonRpcFrame(oversized, 1, 0)).toThrow('Message too large')
    expect(() => mainProtocol.encodeJsonRpcFrame(oversized, 1, 0)).toThrow('Message too large')
  })
})
