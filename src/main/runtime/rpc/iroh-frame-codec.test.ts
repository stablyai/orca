import { describe, expect, it, vi } from 'vitest'
import {
  createFrameDecoder,
  decodeIrohFramePayload,
  encodeIrohFramePayload,
  encodeLengthPrefixedFrame,
  IROH_MAX_FRAME_BYTES
} from './iroh-frame-codec'

describe('iroh frame codec', () => {
  it('round-trips a small payload', () => {
    const payload = new TextEncoder().encode('{"type":"e2ee_hello"}')
    const frame = encodeLengthPrefixedFrame(payload)
    expect(frame.readUInt32BE(0)).toBe(payload.byteLength)
    expect(frame.subarray(4)).toEqual(Buffer.from(payload))

    const onFrame = vi.fn()
    const decoder = createFrameDecoder({ onFrame, onOversize: vi.fn() })
    decoder.feed(frame)
    expect(onFrame).toHaveBeenCalledTimes(1)
    expect(onFrame.mock.calls[0]?.[0]).toEqual(payload)
  })

  it('reassembles frames split across chunk boundaries', () => {
    const payload = new TextEncoder().encode('abcdefghijklmnop')
    const frame = encodeLengthPrefixedFrame(payload)
    const onFrame = vi.fn()
    const decoder = createFrameDecoder({ onFrame, onOversize: vi.fn() })

    decoder.feed(frame.subarray(0, 2))
    decoder.feed(frame.subarray(2, 7))
    decoder.feed(frame.subarray(7))

    expect(onFrame).toHaveBeenCalledTimes(1)
    expect(Buffer.from(onFrame.mock.calls[0]?.[0] as Uint8Array).toString('utf8')).toBe(
      'abcdefghijklmnop'
    )
  })

  it('decodes multiple frames from one buffer', () => {
    const a = encodeLengthPrefixedFrame(new TextEncoder().encode('one'))
    const b = encodeLengthPrefixedFrame(new TextEncoder().encode('two'))
    const onFrame = vi.fn()
    const decoder = createFrameDecoder({ onFrame, onOversize: vi.fn() })
    decoder.feed(Buffer.concat([a, b]))
    expect(onFrame).toHaveBeenCalledTimes(2)
    expect(Buffer.from(onFrame.mock.calls[0]?.[0] as Uint8Array).toString('utf8')).toBe('one')
    expect(Buffer.from(onFrame.mock.calls[1]?.[0] as Uint8Array).toString('utf8')).toBe('two')
  })

  it('rejects oversize declared lengths and clears state', () => {
    const onFrame = vi.fn()
    const onOversize = vi.fn()
    const decoder = createFrameDecoder({ onFrame, onOversize })
    const header = Buffer.alloc(4)
    header.writeUInt32BE(IROH_MAX_FRAME_BYTES + 1, 0)
    decoder.feed(header)
    expect(onOversize).toHaveBeenCalledWith(IROH_MAX_FRAME_BYTES + 1)
    expect(onFrame).not.toHaveBeenCalled()

    // Subsequent valid frame still works after oversize reset.
    decoder.feed(encodeLengthPrefixedFrame(new TextEncoder().encode('ok')))
    expect(onFrame).toHaveBeenCalledTimes(1)
  })

  it('throws when encoding an oversize payload', () => {
    const payload = new Uint8Array(IROH_MAX_FRAME_BYTES + 1)
    expect(() => encodeLengthPrefixedFrame(payload)).toThrow(/exceeds/)
  })

  it('classifies ASCII payloads as text and high-entropy as binary', () => {
    expect(decodeIrohFramePayload(new TextEncoder().encode('{"type":"e2ee_hello"}'))).toBe(
      '{"type":"e2ee_hello"}'
    )
    const binary = new Uint8Array([0, 1, 2, 200, 255])
    expect(decodeIrohFramePayload(binary)).toEqual(binary)
  })

  it('encodes string and binary payloads for the wire', () => {
    expect(Buffer.from(encodeIrohFramePayload('hi')).toString('utf8')).toBe('hi')
    expect(encodeIrohFramePayload(new Uint8Array([1, 2, 3]))).toEqual(new Uint8Array([1, 2, 3]))
  })
})
