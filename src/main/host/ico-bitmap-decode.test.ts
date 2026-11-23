import { describe, expect, it } from 'vitest'
import { decodeIcoEntry } from './ico-bitmap-decode'

// A 2x2, 4 bpp icon: palette red and blue, bottom-up rows, and an AND mask hiding the top-left pixel.
function fourBitIcon(): Buffer {
  const dib = Buffer.alloc(40 + 16 * 4 + 2 * 4 + 2 * 4)
  dib.writeUInt32LE(40, 0)
  dib.writeInt32LE(2, 4)
  dib.writeInt32LE(4, 8)
  dib.writeUInt16LE(1, 12)
  dib.writeUInt16LE(4, 14)
  Buffer.from([0, 0, 255, 0]).copy(dib, 40)
  Buffer.from([255, 0, 0, 0]).copy(dib, 44)
  // Bottom row: red, blue. Top row: blue, red.
  dib[104] = 0x01
  dib[108] = 0x10
  // Mask rows, bottom first: nothing hidden, then the top row's first pixel.
  dib[116] = 0x80
  const header = Buffer.alloc(22)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  header[6] = 2
  header[7] = 2
  header.writeUInt32LE(dib.length, 14)
  header.writeUInt32LE(22, 18)
  return Buffer.concat([header, dib])
}

describe('decodeIcoEntry', () => {
  it('turns a palettized bitmap into top-down premultiplied BGRA with the mask as alpha', () => {
    const decoded = decodeIcoEntry(fourBitIcon(), 32)
    expect(decoded?.kind).toBe('bitmap')
    expect(decoded?.kind === 'bitmap' && [...decoded.bgra]).toEqual([
      0, 0, 0, 0, 0, 0, 255, 255, 0, 0, 255, 255, 255, 0, 0, 255
    ])
  })
})
