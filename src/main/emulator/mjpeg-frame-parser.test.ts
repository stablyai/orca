import { describe, expect, it } from 'vitest'
import { MjpegFrameAccumulator } from './mjpeg-frame-parser'

describe('MjpegFrameAccumulator', () => {
  const LONG_JPEG = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from(Array.from({ length: 40 }, (_, index) => (index % 5 === 0 ? 0xff : index))),
    Buffer.from([0xff, 0xd9])
  ])

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
