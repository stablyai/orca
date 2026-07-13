import { describe, expect, it } from 'vitest'
import {
  encodeNativeMessage,
  NativeMessageDecoder,
  NativeMessageFrameError,
  MAX_FRAME_BYTES
} from './native-messaging-frame'

describe('native messaging framing', () => {
  it('round-trips a single message', () => {
    const encoded = encodeNativeMessage({ type: 'INGEST', ok: true })
    // 4-byte LE length prefix + UTF-8 JSON body.
    const bodyLen = encoded.readUInt32LE(0)
    expect(encoded.length).toBe(4 + bodyLen)
    const decoder = new NativeMessageDecoder()
    const out = decoder.feed(encoded)
    expect(out).toHaveLength(1)
    expect(JSON.parse(out[0])).toEqual({ type: 'INGEST', ok: true })
  })

  it('reassembles a message split across chunks', () => {
    const encoded = encodeNativeMessage({ a: 1, b: 'two' })
    const decoder = new NativeMessageDecoder()
    expect(decoder.feed(encoded.subarray(0, 3))).toEqual([])
    expect(decoder.feed(encoded.subarray(3, 6))).toEqual([])
    const out = decoder.feed(encoded.subarray(6))
    expect(JSON.parse(out[0])).toEqual({ a: 1, b: 'two' })
  })

  it('yields multiple messages from one chunk', () => {
    const buf = Buffer.concat([encodeNativeMessage({ n: 1 }), encodeNativeMessage({ n: 2 })])
    const out = new NativeMessageDecoder().feed(buf)
    expect(out.map((s) => JSON.parse(s))).toEqual([{ n: 1 }, { n: 2 }])
  })

  it('throws on an oversized length prefix', () => {
    const header = Buffer.alloc(4)
    header.writeUInt32LE(MAX_FRAME_BYTES + 1, 0)
    expect(() => new NativeMessageDecoder().feed(header)).toThrow(NativeMessageFrameError)
  })
})
