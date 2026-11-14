import { describe, expect, it } from 'vitest'
import { AvccFrameParser, type AvccFrame } from './avcc-frame-parser'

function packet(tag: number, payload: number[]): number[] {
  const length = payload.length + 1
  return [
    length >>> 24,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    tag,
    ...payload
  ]
}

function parse(chunks: number[][]): { frame: AvccFrame; bytes: number[] }[] {
  const frames: { frame: AvccFrame; bytes: number[] }[] = []
  const parser = new AvccFrameParser((frame) =>
    frames.push({ frame, bytes: [...new Uint8Array(frame.bytes)] })
  )
  for (const chunk of chunks) {
    parser.push(Uint8Array.from(chunk))
  }
  return frames
}

describe('AvccFrameParser', () => {
  it('reassembles description, IDR and delta packets split anywhere across chunks', () => {
    const wire = [...packet(1, [1, 0x64, 0, 0x33]), ...packet(2, [9, 9, 9]), ...packet(3, [7])]
    const frames = parse([wire.slice(0, 3), wire.slice(3, 11), wire.slice(11, 12), wire.slice(12)])

    expect(frames.map(({ frame, bytes }) => [frame.config, frame.keyFrame, bytes])).toEqual([
      [true, false, [1, 0x64, 0, 0x33]],
      [false, true, [9, 9, 9]],
      [false, false, [7]]
    ])
  })
})
