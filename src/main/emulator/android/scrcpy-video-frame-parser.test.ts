import { describe, expect, it } from 'vitest'
import { RelayFrameBuffer } from '../../../shared/relay-frame-buffer'
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
    const pending = new RelayFrameBuffer()
    pending.append(stream)
    const frames = parseScrcpyVideoFrames(pending)
    expect(pending.length).toBe(0)
    expect(frames).toHaveLength(2)
    expect(frames[0]).toMatchObject({ config: true, keyFrame: false })
    expect([...frames[0].data]).toEqual([0, 0, 0, 1])
    expect(frames[1]).toMatchObject({ config: false, keyFrame: true, pts: 123n })
    expect([...frames[1].data]).toEqual([1, 2, 3])
  })

  it('buffers a partial frame across chunks', () => {
    const full = frame(5n, [9, 9, 9, 9])
    const pending = new RelayFrameBuffer()
    pending.append(full.subarray(0, 14))
    expect(parseScrcpyVideoFrames(pending)).toHaveLength(0)
    expect(pending.length).toBe(14)
    pending.append(full.subarray(14))
    const frames = parseScrcpyVideoFrames(pending)
    expect(frames).toHaveLength(1)
    expect([...frames[0].data]).toEqual([9, 9, 9, 9])
    expect(pending.length).toBe(0)
  })

  it('does not retain a consumed large packet behind a one-byte pending suffix', () => {
    const first = Buffer.alloc(4 * 1024 * 1024 + 12, 7)
    first.writeBigUInt64BE(123n, 0)
    first.writeUInt32BE(first.length - 12, 8)
    const second = frame(KEY | 456n, [1, 2, 3])
    const chunk = Buffer.concat([first, second.subarray(0, 1)])
    const pending = new RelayFrameBuffer()
    pending.append(chunk)

    const frames = parseScrcpyVideoFrames(pending)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ config: false, keyFrame: false, pts: 123n })
    expect(frames[0].data.equals(first.subarray(12))).toBe(true)
    expect(pending.length).toBe(1)
    expect(pending.peek(1)).toEqual(second.subarray(0, 1))
    expect(pending.peek(1).buffer === chunk.buffer).toBe(false)
    expect(pending.peek(1).buffer.byteLength).toBeLessThan(chunk.length)

    chunk.fill(0xff)
    pending.append(second.subarray(1))
    expect(parseScrcpyVideoFrames(pending)).toEqual([
      { config: false, keyFrame: true, pts: 456n, data: Buffer.from([1, 2, 3]) }
    ])
    expect(pending.length).toBe(0)
  })

  it('keeps mostly live chunk storage instead of recopying a large pending frame', () => {
    const first = frame(123n, [1, 2, 3])
    const second = Buffer.alloc(4 * 1024 * 1024 + 12, 7)
    second.writeBigUInt64BE(KEY | 456n, 0)
    second.writeUInt32BE(second.length - 12, 8)
    const split = 3 * 1024 * 1024
    const chunk = Buffer.concat([first, second.subarray(0, split)])
    const pending = new RelayFrameBuffer()
    pending.append(chunk)

    expect(parseScrcpyVideoFrames(pending)).toHaveLength(1)
    expect(pending.length).toBe(split)
    expect(pending.peek(1).buffer === chunk.buffer).toBe(true)

    pending.append(second.subarray(split))
    const frames = parseScrcpyVideoFrames(pending)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ config: false, keyFrame: true, pts: 456n })
    expect(frames[0].data.equals(second.subarray(12))).toBe(true)
    expect(pending.length).toBe(0)
  })

  it('holds an incomplete header until more bytes arrive', () => {
    const pending = new RelayFrameBuffer()
    pending.append(Buffer.from([0, 1, 2]))
    expect(parseScrcpyVideoFrames(pending)).toHaveLength(0)
    expect(pending.length).toBe(3)
  })

  it('throws on a desynced frame size instead of buffering toward OOM', () => {
    // A header declaring a frame far larger than any real one would otherwise
    // never be satisfied, leaving the whole buffer pending forever.
    const header = Buffer.alloc(12)
    header.writeUInt32BE(64 * 1024 * 1024, 8)
    const pending = new RelayFrameBuffer()
    pending.append(header)
    expect(() => parseScrcpyVideoFrames(pending)).toThrow(/desynced/)
  })
})
