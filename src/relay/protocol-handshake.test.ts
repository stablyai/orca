import { describe, expect, it } from 'vitest'
import {
  MessageType,
  HEADER_LENGTH,
  MAX_BUFFERED_FRAME_CHUNKS,
  MAX_COALESCED_TINY_FRAME_CHUNK_BYTES,
  FrameDecoder,
  encodeHandshakeFrame,
  parseHandshakeMessage,
  type DecodedFrame
} from './protocol'

describe('handshake framing', () => {
  it('bounds retained chunk wrappers for an adversarially fragmented frame', () => {
    expect(MAX_BUFFERED_FRAME_CHUNKS).toBe(4_096)
    const frames: DecodedFrame[] = []
    const decoder = new FrameDecoder((frame) => frames.push(frame))
    const largestChunk = 4_097
    const payloadLength = (largestChunk * (largestChunk + 1)) / 2 + 1
    const header = Buffer.alloc(HEADER_LENGTH)
    header[0] = MessageType.Regular
    header.writeUInt32BE(payloadLength, 9)
    decoder.feed(header)

    const state = decoder as unknown as { chunks: Buffer[] }
    for (let chunkSize = largestChunk; chunkSize >= 1; chunkSize -= 1) {
      decoder.feed(Buffer.alloc(chunkSize))
      expect(state.chunks.length).toBeLessThanOrEqual(4_096)
    }

    expect(frames).toHaveLength(0)
  })

  it('does not coalesce ordinary transport chunks while a frame is incomplete', () => {
    expect(MAX_COALESCED_TINY_FRAME_CHUNK_BYTES).toBe(8 * 1024)
    const decoder = new FrameDecoder(() => {})
    const header = Buffer.alloc(HEADER_LENGTH)
    header[0] = MessageType.Regular
    header.writeUInt32BE(1024 * 1024, 9)
    decoder.feed(header)
    const ordinaryChunks = Array.from({ length: 16 }, () => Buffer.alloc(32 * 1024))

    for (const chunk of ordinaryChunks) {
      decoder.feed(chunk)
    }

    const state = decoder as unknown as { chunks: Buffer[] }
    expect(state.chunks).toHaveLength(ordinaryChunks.length + 1)
    for (const [index, chunk] of ordinaryChunks.entries()) {
      expect(state.chunks[index + 1]).toBe(chunk)
    }
  })

  it('stream-discards an oversized payload instead of buffering toward its advertised size', () => {
    const errors: Error[] = []
    const decoder = new FrameDecoder(
      () => {},
      (error) => errors.push(error)
    )
    const header = Buffer.alloc(HEADER_LENGTH)
    header[0] = MessageType.Regular
    header.writeUInt32BE(0xffffffff, 9)

    decoder.feed(header)
    const state = decoder as unknown as {
      bufferedLength: number
      oversizedPayloadBytesRemaining: number
    }
    expect(errors).toHaveLength(1)
    expect(state.bufferedLength).toBe(0)

    const payloadChunk = Buffer.alloc(64 * 1024)
    for (let index = 0; index < 128; index += 1) {
      decoder.feed(payloadChunk)
      expect(state.bufferedLength).toBe(0)
    }
    expect(state.oversizedPayloadBytesRemaining).toBe(0xffffffff - 128 * payloadChunk.length)
    expect(errors).toHaveLength(1)
  })

  it('round-trips an orca-relay-handshake envelope through the existing framing', () => {
    const sent = encodeHandshakeFrame({
      type: 'orca-relay-handshake',
      version: '0.1.0+deadbeef'
    })
    expect(sent[0]).toBe(MessageType.Handshake)
    expect(sent.length).toBeGreaterThan(HEADER_LENGTH)

    const frames: DecodedFrame[] = []
    const decoder = new FrameDecoder((f) => frames.push(f))
    decoder.feed(sent)

    expect(frames).toHaveLength(1)
    expect(frames[0].type).toBe(MessageType.Handshake)
    const msg = parseHandshakeMessage(frames[0].payload)
    expect(msg).toEqual({ type: 'orca-relay-handshake', version: '0.1.0+deadbeef' })
  })

  it('round-trips an orca-relay-handshake-ok reply', () => {
    const sent = encodeHandshakeFrame({
      type: 'orca-relay-handshake-ok',
      version: '0.1.0+deadbeef'
    })
    const frames: DecodedFrame[] = []
    const decoder = new FrameDecoder((f) => frames.push(f))
    decoder.feed(sent)
    const msg = parseHandshakeMessage(frames[0].payload)
    expect(msg).toEqual({ type: 'orca-relay-handshake-ok', version: '0.1.0+deadbeef' })
  })

  it('round-trips an orca-relay-handshake-mismatch reply', () => {
    const sent = encodeHandshakeFrame({
      type: 'orca-relay-handshake-mismatch',
      expected: '0.1.0+aaa',
      got: '0.1.0+bbb'
    })
    const frames: DecodedFrame[] = []
    const decoder = new FrameDecoder((f) => frames.push(f))
    decoder.feed(sent)
    const msg = parseHandshakeMessage(frames[0].payload)
    expect(msg).toEqual({
      type: 'orca-relay-handshake-mismatch',
      expected: '0.1.0+aaa',
      got: '0.1.0+bbb'
    })
  })

  it('rejects payloads with unknown type', () => {
    const bogus = Buffer.from(JSON.stringify({ type: 'orca-something-else', version: 'x' }))
    expect(() => parseHandshakeMessage(bogus)).toThrow(/Unknown handshake type/)
  })

  it('handshake frames use a distinct MessageType from Regular and KeepAlive', () => {
    expect(MessageType.Handshake).not.toBe(MessageType.Regular)
    expect(MessageType.Handshake).not.toBe(MessageType.KeepAlive)
  })
})
