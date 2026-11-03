import { afterEach, describe, expect, it, vi } from 'vitest'
import { AvccFrameParser, type AvccFrame } from './avcc-frame-parser'

function packet(tag: number, bytes: number[]): Buffer {
  const header = Buffer.alloc(5)
  header.writeUInt32BE(bytes.length + 1)
  header[4] = tag
  return Buffer.concat([header, Buffer.from(bytes)])
}

const packets = [
  packet(1, [1, 100, 0, 40, 255, 225, 0]),
  packet(2, [0, 0, 0, 2, 101, 1]),
  packet(3, [0, 0, 0, 2, 65, 2]),
  packet(4, [255, 216, 1, 255, 217])
]
const wire = Buffer.concat(packets)
const expected = [
  { config: true, keyFrame: false, bytes: Uint8Array.from([1, 100, 0, 40, 255, 225, 0]).buffer },
  { config: false, keyFrame: true, bytes: Uint8Array.from([0, 0, 0, 2, 101, 1]).buffer },
  { config: false, keyFrame: false, bytes: Uint8Array.from([0, 0, 0, 2, 65, 2]).buffer },
  {
    config: false,
    keyFrame: false,
    seed: true,
    bytes: Uint8Array.from([255, 216, 1, 255, 217]).buffer
  }
]

afterEach(() => vi.restoreAllMocks())

describe('AvccFrameParser', () => {
  it('preserves all packets for every pair of header and payload split boundaries', () => {
    for (let first = 0; first <= wire.length; first++) {
      for (let second = first; second <= wire.length; second++) {
        const frames: AvccFrame[] = []
        const parser = new AvccFrameParser((frame) => frames.push(frame))
        parser.push(wire.subarray(0, first))
        parser.push(wire.subarray(first, second))
        parser.push(wire.subarray(second))
        expect(frames).toEqual(expected)
      }
    }
  })

  it('emits only complete packets when every byte arrives separately', () => {
    const frames: AvccFrame[] = []
    const parser = new AvccFrameParser((frame) => frames.push(frame))
    let offset = 0
    for (let index = 0; index < packets.length; index++) {
      const end = offset + packets[index].length
      for (; offset < end - 1; offset++) {
        parser.push(wire.subarray(offset, offset + 1))
        expect(frames).toHaveLength(index)
      }
      parser.push(wire.subarray(offset, offset + 1))
      offset++
      expect(frames).toEqual(expected.slice(0, index + 1))
    }
  })

  it('owns an exact payload buffer without retaining or sharing mutable input storage', () => {
    const frames: AvccFrame[] = []
    const parser = new AvccFrameParser((frame) => frames.push(frame))
    const first = Buffer.from(packets[0].subarray(0, 8))
    parser.push(first)
    first.fill(0)
    const rest = Buffer.concat([packets[0].subarray(8), packets[1]])
    parser.push(rest)
    rest.fill(0)
    expect(frames).toEqual(expected.slice(0, 2))
    expect(frames[0].bytes.byteLength).toBe(7)
    expect(frames[1].bytes.byteLength).toBe(6)
    new Uint8Array(frames[1].bytes).fill(0)
    expect(frames[0]).toEqual(expected[0])
  })

  it.each([0, 1, 32 * 1024 * 1024 + 1, 0xffffffff])(
    'rejects outer length %i before allocating a payload',
    (length) => {
      const parser = new AvccFrameParser(() => {
        throw new Error('Invalid packet must not be delivered')
      })
      const header = Buffer.alloc(5)
      header.writeUInt32BE(length)
      header[4] = 2
      const allocations = vi.spyOn(globalThis, 'ArrayBuffer')
      expect(() => parser.push(header)).toThrow(/length/i)
      expect(allocations).not.toHaveBeenCalled()
    }
  )

  it.each([0, 5, 255])('rejects tag %i before allocating its bounded payload', (tag) => {
    const parser = new AvccFrameParser(() => {
      throw new Error('Invalid packet must not be delivered')
    })
    const header = Buffer.alloc(5)
    header.writeUInt32BE(32 * 1024 * 1024)
    header[4] = tag
    const allocations = vi.spyOn(globalThis, 'ArrayBuffer')
    expect(() => parser.push(header)).toThrow(/tag/i)
    expect(allocations).not.toHaveBeenCalled()
  })

  it('accepts the 32 MiB outer bound and allocates only its tag-free payload once', () => {
    const parser = new AvccFrameParser(() => {
      throw new Error('Incomplete packet must not be delivered')
    })
    const header = Buffer.alloc(5)
    header.writeUInt32BE(32 * 1024 * 1024)
    header[4] = 2
    const allocations = vi.spyOn(globalThis, 'ArrayBuffer')
    parser.push(header)
    parser.push(Buffer.from([1, 2, 3]))
    expect(allocations.mock.calls).toEqual([[32 * 1024 * 1024 - 1]])
    parser.reset()
  })

  it('discards unfinished data on reset without leaking it into a later packet', () => {
    const frames: AvccFrame[] = []
    const parser = new AvccFrameParser((frame) => frames.push(frame))
    parser.push(packets[0].subarray(0, 8))
    parser.reset()
    parser.push(packets[1].subarray(0, 2))
    parser.reset()
    parser.push(packets[2])
    expect(frames).toEqual([expected[2]])
  })
})
