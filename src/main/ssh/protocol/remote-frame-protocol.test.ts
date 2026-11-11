import { describe, expect, it } from 'vitest'
import { HEADER_LENGTH, FrameDecoder } from '../../../shared/relay-frame-decoder'
import type { DecodedFrame } from '../../../shared/relay-frame-decoder-contract'
import { MessageType, encodeFrame, encodeJsonRpcFrame } from './remote-frame-protocol'

describe('frame encoding', () => {
  it('rejects messages larger than MAX_MESSAGE_SIZE', () => {
    const bigPayload = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'x',
      params: { data: 'a'.repeat(17 * 1024 * 1024) }
    }
    expect(() => encodeJsonRpcFrame(bigPayload, 1, 0)).toThrow('Message too large')
  })
})

describe('FrameDecoder', () => {
  // Freeze clock for framing cases; relay-protocol-backpressure.test.ts separately covers time-sliced drain under CI load.
  const frozenClock = { now: () => 0 }

  it('skips an oversized frame fed in odd-sized chunks and resynchronizes', () => {
    const errors: Error[] = []
    const frames: DecodedFrame[] = []
    const decoder = new FrameDecoder(
      (f) => frames.push(f),
      (err) => errors.push(err),
      frozenClock
    )

    const oversizedLength = 17 * 1024 * 1024
    const header = Buffer.alloc(HEADER_LENGTH)
    header[0] = MessageType.Regular
    header.writeUInt32BE(1, 1)
    header.writeUInt32BE(0, 5)
    header.writeUInt32BE(oversizedLength, 9)
    const oversized = Buffer.concat([header, Buffer.alloc(oversizedLength)])
    const valid = encodeFrame(MessageType.Regular, 2, 0, Buffer.from('after'))
    const combined = Buffer.concat([oversized, valid])

    const chunkSize = 1024 * 1024 - 7
    for (let i = 0; i < combined.length; i += chunkSize) {
      decoder.feed(combined.subarray(i, i + chunkSize))
    }

    expect(errors).toHaveLength(1)
    expect(frames).toHaveLength(1)
    expect(frames[0].payload.toString()).toBe('after')
  })
})
