import { describe, expect, it } from 'vitest'
import { extractJpegFrames } from './mjpeg-frame-parser'

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

  // Regression: frames are returned as views into the chunk (no per-frame copy),
  // so the retained `pending` must still be an independent copy — otherwise a
  // later mutation of the source chunk could corrupt buffered partial frames.
  it('does not retain a view aliased to the input chunk', () => {
    const chunk = Buffer.concat([JPEG_A, Buffer.from([0xff, 0xd8, 0x09])]) // A + partial B
    const result = extractJpegFrames(Buffer.alloc(0), chunk)

    expect(result.frames).toEqual([JPEG_A])
    expect(result.pending).toEqual(Buffer.from([0xff, 0xd8, 0x09]))

    // Mutating the original chunk after parsing must not change pending.
    chunk.fill(0)
    expect(result.pending).toEqual(Buffer.from([0xff, 0xd8, 0x09]))
  })
})
