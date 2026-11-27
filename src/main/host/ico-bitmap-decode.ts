const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47]
const DIB_HEADER_BYTES = 40

export type IcoEntry =
  | { kind: 'png'; bytes: Uint8Array }
  | { kind: 'bitmap'; width: number; height: number; bgra: Buffer }

type DirectoryEntry = { size: number; bitCount: number; offset: number; length: number }

function directory(bytes: Buffer): DirectoryEntry[] {
  if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) {
    return []
  }
  const entries: DirectoryEntry[] = []
  for (let index = 0; index < bytes.readUInt16LE(4); index += 1) {
    const at = 6 + index * 16
    if (at + 16 > bytes.length) {
      break
    }
    const length = bytes.readUInt32LE(at + 8)
    const offset = bytes.readUInt32LE(at + 12)
    if (offset + length <= bytes.length) {
      entries.push({ size: bytes[at] || 256, bitCount: bytes.readUInt16LE(at + 6), offset, length })
    }
  }
  return entries
}

/** Images at least `edge` wide from the smallest up, then smaller ones; deepest colour first per size. */
function candidates(entries: DirectoryEntry[], edge: number): DirectoryEntry[] {
  const byDepth = (a: DirectoryEntry, b: DirectoryEntry) => b.bitCount - a.bitCount
  const large = entries.filter((entry) => entry.size >= edge)
  const small = entries.filter((entry) => entry.size < edge)
  return [
    ...large.toSorted((a, b) => a.size - b.size || byDepth(a, b)),
    ...small.toSorted((a, b) => b.size - a.size || byDepth(a, b))
  ]
}

function rowBytes(width: number, bitCount: number): number {
  return Math.ceil((width * bitCount) / 32) * 4
}

// nativeImage.createFromBitmap takes Skia's premultiplied pixels.
function premultiply(bgra: Buffer): void {
  for (let at = 0; at < bgra.length; at += 4) {
    const alpha = bgra[at + 3]
    if (alpha < 255) {
      for (let channel = at; channel < at + 3; channel += 1) {
        bgra[channel] = Math.round((bgra[channel] * alpha) / 255)
      }
    }
  }
}

// BMP pixels are bottom-up, palettized at 8 bpp or less, and transparent where the AND mask is set.
function decodeDib(dib: Buffer): IcoEntry | null {
  if (dib.length < DIB_HEADER_BYTES || dib.readUInt32LE(0) < DIB_HEADER_BYTES) {
    return null
  }
  const width = dib.readInt32LE(4)
  // The stored height covers the colour rows and the mask rows together.
  const storedHeight = dib.readInt32LE(8)
  const height = storedHeight / 2
  const bitCount = dib.readUInt16LE(14)
  if (
    width <= 0 ||
    storedHeight <= 0 ||
    storedHeight % 2 !== 0 ||
    width > 256 ||
    height > 256 ||
    dib.readUInt32LE(16) !== 0 ||
    ![1, 4, 8, 24, 32].includes(bitCount)
  ) {
    return null
  }
  const paletteCount = bitCount <= 8 ? dib.readUInt32LE(32) || 2 ** bitCount : 0
  const paletteAt = dib.readUInt32LE(0)
  const pixelsAt = paletteAt + paletteCount * 4
  const xorRow = rowBytes(width, bitCount)
  const andRow = rowBytes(width, 1)
  const maskAt = pixelsAt + xorRow * height
  if (maskAt > dib.length) {
    return null
  }
  const hasMask = maskAt + andRow * height <= dib.length
  const bgra = Buffer.alloc(width * height * 4)
  let anyAlpha = false
  for (let y = 0; y < height; y += 1) {
    const row = pixelsAt + (height - 1 - y) * xorRow
    for (let x = 0; x < width; x += 1) {
      const out = (y * width + x) * 4
      if (bitCount >= 24) {
        const at = row + x * (bitCount / 8)
        dib.copy(bgra, out, at, at + 3)
        bgra[out + 3] = bitCount === 32 ? dib[at + 3] : 255
      } else {
        const bit = x * bitCount
        const index = (dib[row + (bit >> 3)] >> (8 - bitCount - (bit & 7))) & (2 ** bitCount - 1)
        const color = paletteAt + Math.min(index, paletteCount - 1) * 4
        dib.copy(bgra, out, color, color + 3)
        bgra[out + 3] = 255
      }
      anyAlpha ||= bitCount === 32 && bgra[out + 3] !== 0
    }
  }
  // 32 bpp icons carry real alpha; otherwise the mask decides, opaque where its bit is clear.
  if (!(bitCount === 32 && anyAlpha)) {
    for (let y = 0; y < height; y += 1) {
      const row = maskAt + (height - 1 - y) * andRow
      for (let x = 0; x < width; x += 1) {
        const hidden = hasMask && (dib[row + (x >> 3)] >> (7 - (x & 7))) & 1
        bgra[(y * width + x) * 4 + 3] = hidden ? 0 : 255
      }
    }
  }
  premultiply(bgra)
  return { kind: 'bitmap', width, height, bgra }
}

/** The ICO image best suited to `edge` px: its embedded PNG, or its bitmap as BGRA pixels. */
export function decodeIcoEntry(bytes: Uint8Array, edge: number): IcoEntry | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (const entry of candidates(directory(buffer), edge)) {
    const data = buffer.subarray(entry.offset, entry.offset + entry.length)
    if (PNG_SIGNATURE.every((byte, index) => data[index] === byte)) {
      return { kind: 'png', bytes: data }
    }
    const bitmap = decodeDib(data)
    if (bitmap) {
      return bitmap
    }
  }
  return null
}
