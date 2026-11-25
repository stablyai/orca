// A shared avatar keeps only the chunks that draw it: text, EXIF, time and other metadata stay home.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const DRAWING_CHUNKS = new Set(['IHDR', 'PLTE', 'tRNS', 'gAMA', 'sRGB', 'IDAT', 'IEND'])

/** The PNG with every non-drawing chunk dropped; null when it isn't a well-formed PNG. */
export function stripPngMetadata(png: Uint8Array): Buffer | null {
  const bytes = Buffer.from(png)
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return null
  }
  const kept: Buffer[] = [PNG_SIGNATURE]
  let offset = PNG_SIGNATURE.length
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > bytes.length) {
      return null
    }
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    if (DRAWING_CHUNKS.has(type)) {
      kept.push(bytes.subarray(offset, end))
    }
    offset = end
    if (type === 'IEND') {
      return Buffer.concat(kept)
    }
  }
  return null
}
