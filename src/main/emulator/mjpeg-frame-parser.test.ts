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
})
