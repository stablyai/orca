import { describe, expect, it } from 'vitest'
import { createNativeMessageReader, encodeNativeMessage } from './native-message-codec'

describe('native message codec', () => {
  it('prefixes the JSON body with its byte length', () => {
    const encoded = encodeNativeMessage({ text: 'é' })
    const body = JSON.stringify({ text: 'é' })
    expect(encoded.readUInt32LE(0)).toBe(Buffer.byteLength(body))
    expect(encoded.subarray(4).toString('utf8')).toBe(body)
  })

  it('reassembles messages split and joined across chunks', () => {
    const received: unknown[] = []
    const read = createNativeMessageReader((message) => received.push(message))
    const wire = Buffer.concat([encodeNativeMessage({ a: 1 }), encodeNativeMessage([2, 3])])
    read(wire.subarray(0, 3))
    read(wire.subarray(3, 12))
    read(wire.subarray(12))
    expect(received).toEqual([{ a: 1 }, [2, 3]])
  })

  it('refuses a message over the 1 MB host limit', () => {
    const read = createNativeMessageReader(() => {})
    const header = Buffer.alloc(4)
    header.writeUInt32LE(1024 * 1024 + 1)
    expect(() => read(header)).toThrow('too large')
  })
})
