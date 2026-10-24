import { describe, expect, it } from 'vitest'
import { MjpegFrameAccumulator, extractJpegFrames } from './mjpeg-frame-parser'

const JPEG_A = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9])
const JPEG_B = Buffer.from([0xff, 0xd8, 0x03, 0x04, 0xff, 0xd9])

describe('extractJpegFrames', () => {
  it('extracts complete JPEG frames from a stream chunk', () => {
    const result = extractJpegFrames(Buffer.alloc(0), Buffer.concat([JPEG_A, JPEG_B]))

    expect(result.frames).toEqual([JPEG_A, JPEG_B])
    expect(result.pending.length).toBe(0)
  })

  it('keeps partial frames for the next chunk', () => {
    const first = extractJpegFrames(Buffer.alloc(0), JPEG_A.subarray(0, 4))
    const second = extractJpegFrames(first.pending, JPEG_A.subarray(4))

    expect(first.frames).toEqual([])
    expect(second.frames).toEqual([JPEG_A])
    expect(second.pending.length).toBe(0)
  })

  it('preserves a split JPEG start marker', () => {
    const first = extractJpegFrames(Buffer.alloc(0), Buffer.from([0x00, 0xff]))
    const second = extractJpegFrames(first.pending, JPEG_A.subarray(1))

    expect(second.frames).toEqual([JPEG_A])
  })

  // Retained partial frames must not share mutable input storage.
  it('does not retain a view aliased to the input chunk', () => {
    const chunk = Buffer.concat([JPEG_A, Buffer.from([0xff, 0xd8, 0x09])])
    const result = extractJpegFrames(Buffer.alloc(0), chunk)

    expect(result.frames).toEqual([JPEG_A])
    expect(result.pending).toEqual(Buffer.from([0xff, 0xd8, 0x09]))

    chunk.fill(0)
    expect(result.pending).toEqual(Buffer.from([0xff, 0xd8, 0x09]))
  })
})

describe('MjpegFrameAccumulator', () => {
  const LONG_JPEG = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from(Array.from({ length: 40 }, (_, index) => (index % 5 === 0 ? 0xff : index))),
    Buffer.from([0xff, 0xd9])
  ])
  const stream = Buffer.concat([
    Buffer.from('--frame\r\nContent-Type: image/jpeg\r\n\r\n'),
    LONG_JPEG,
    Buffer.from('\r\n--frame\r\n\r\n'),
    JPEG_B
  ])

  it.each([1, 2, 3, 7, 16, stream.length])(
    'returns the same frames as extractJpegFrames for %i-byte chunks',
    (size) => {
      const accumulator = new MjpegFrameAccumulator()
      const frames: Buffer[] = []
      let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      const expected: Buffer[] = []
      for (let offset = 0; offset < stream.length; offset += size) {
        const chunk = stream.subarray(offset, offset + size)
        frames.push(...accumulator.push(chunk).map((frame) => Buffer.from(frame)))
        const result = extractJpegFrames(pending, chunk)
        pending = result.pending
        expected.push(...result.frames.map((frame) => Buffer.from(frame)))
      }

      expect(frames).toEqual([LONG_JPEG, JPEG_B])
      expect(frames).toEqual(expected)
    }
  )

  it('does not retain caller chunk memory while a frame is buffered', () => {
    const accumulator = new MjpegFrameAccumulator()
    const first = Buffer.from(LONG_JPEG.subarray(0, 10))
    const middle = Buffer.from(LONG_JPEG.subarray(10, 30))
    expect(accumulator.push(first)).toEqual([])
    expect(accumulator.push(middle)).toEqual([])
    first.fill(0)
    middle.fill(0)

    expect(accumulator.push(LONG_JPEG.subarray(30))).toEqual([LONG_JPEG])
  })
})
