import { describe, expect, it } from 'vitest'
import { parseScrcpyVideoFrames, parseScrcpyVideoMeta } from './scrcpy-video-frame-parser'

const CONFIG = 1n << 63n
const KEY = 1n << 62n

function frame(meta: bigint, data: number[]): Buffer {
  const header = Buffer.alloc(12)
  header.writeBigUInt64BE(meta, 0)
  header.writeUInt32BE(data.length, 8)
  return Buffer.concat([header, Buffer.from(data)])
}

describe('parseScrcpyVideoMeta', () => {
  it('parses codec id, width, and height', () => {
    const buffer = Buffer.alloc(12)
    buffer.write('h264', 0, 'ascii')
    buffer.writeUInt32BE(1080, 4)
    buffer.writeUInt32BE(2400, 8)
    expect(parseScrcpyVideoMeta(buffer)).toEqual({ codecId: 'h264', width: 1080, height: 2400 })
  })

  it('returns null when the buffer is too short', () => {
    expect(parseScrcpyVideoMeta(Buffer.alloc(11))).toBeNull()
  })
})

describe('parseScrcpyVideoFrames', () => {
  it('extracts config and key frames with their flags and data', () => {
    const stream = Buffer.concat([frame(CONFIG, [0, 0, 0, 1]), frame(KEY | 123n, [1, 2, 3])])
    const { frames, pending } = parseScrcpyVideoFrames(Buffer.alloc(0), stream)
    expect(pending.length).toBe(0)
    expect(frames).toHaveLength(2)
    expect(frames[0]).toMatchObject({ config: true, keyFrame: false })
    expect([...frames[0].data]).toEqual([0, 0, 0, 1])
    expect(frames[1]).toMatchObject({ config: false, keyFrame: true, pts: 123n })
    expect([...frames[1].data]).toEqual([1, 2, 3])
  })

  it('buffers a partial frame across chunks', () => {
    const full = frame(5n, [9, 9, 9, 9])
    const r1 = parseScrcpyVideoFrames(Buffer.alloc(0), full.subarray(0, 14))
    expect(r1.frames).toHaveLength(0)
    expect(r1.pending.length).toBe(14)
    const r2 = parseScrcpyVideoFrames(r1.pending, full.subarray(14))
    expect(r2.frames).toHaveLength(1)
    expect([...r2.frames[0].data]).toEqual([9, 9, 9, 9])
    expect(r2.pending.length).toBe(0)
  })

  it('holds an incomplete header until more bytes arrive', () => {
    const result = parseScrcpyVideoFrames(Buffer.alloc(0), Buffer.from([0, 1, 2]))
    expect(result.frames).toHaveLength(0)
    expect(result.pending.length).toBe(3)
  })

  it('throws on a desynced frame size instead of buffering toward OOM', () => {
    // A header declaring a frame far larger than any real one would otherwise
    // never be satisfied, leaving the whole buffer pending forever.
    const header = Buffer.alloc(12)
    header.writeUInt32BE(64 * 1024 * 1024, 8)
    expect(() => parseScrcpyVideoFrames(Buffer.alloc(0), header)).toThrow(/desynced/)
  })
})
