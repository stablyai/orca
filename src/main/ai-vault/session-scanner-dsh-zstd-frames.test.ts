import { constants, zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decompressZstdFrames, zstdFrames } from './session-scanner-dsh-zstd-frames'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function frameOf(text: string): Buffer {
  return zstdCompressSync(Buffer.from(text), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 }
  })
}

function decodedText(bytes: Buffer): string {
  return [...decompressZstdFrames(bytes)].map((frame) => frame.toString('utf8')).join('')
}

describe('zstdFrames', () => {
  it('splits concatenated independent frames, which a single decompress call would stop after', () => {
    const bytes = Buffer.concat([
      frameOf('header\n'),
      frameOf('batch one\n'),
      frameOf('batch two\n')
    ])

    expect([...zstdFrames(bytes)]).toHaveLength(3)
    expect(decodedText(bytes)).toBe('header\nbatch one\nbatch two\n')
  })

  it('ignores a trailing frame a live writer has not finished flushing', () => {
    const complete = Buffer.concat([frameOf('header\n'), frameOf('batch one\n')])
    const partial = frameOf('batch two is still being written\n')

    for (const cut of [2, 6, partial.length - 1]) {
      const bytes = Buffer.concat([complete, partial.subarray(0, cut)])
      expect(decodedText(bytes)).toBe('header\nbatch one\n')
    }
  })

  it('steps over an RLE block by its one payload byte, not its declared size', () => {
    // Single-segment frame, 1-byte content size 5, one last RLE block of 'x' x5.
    const rleFrame = Buffer.concat([ZSTD_MAGIC, Buffer.from([0x20, 5, 0x2b, 0x00, 0x00, 0x78])])
    const bytes = Buffer.concat([rleFrame, frameOf('after\n')])

    expect(decodedText(bytes)).toBe('xxxxxafter\n')
  })

  it('skips skippable frames', () => {
    const skippable = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 1, 2, 3])
    const bytes = Buffer.concat([frameOf('a\n'), skippable, frameOf('b\n')])

    expect(decodedText(bytes)).toBe('a\nb\n')
  })

  it('rejects bytes that are not a zstd frame', () => {
    expect(() => [...zstdFrames(Buffer.from('{"type":"session"}\n'))]).toThrow(/zstd frame/)
  })
})
