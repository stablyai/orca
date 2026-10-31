import { readFileSync } from 'node:fs'

/** Treat interrupted PNG cache writes as misses so callers can regenerate them. */
export function readPngCacheEntry(file) {
  try {
    const bytes = readFileSync(file)
    if (
      bytes.length < 45 ||
      bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.subarray(12, 16).toString() !== 'IHDR' ||
      bytes.readUInt32BE(bytes.length - 12) !== 0 ||
      bytes.subarray(-8).toString('hex') !== '49454e44ae426082'
    ) {
      return undefined
    }
    const width = bytes.readUInt32BE(16)
    const height = bytes.readUInt32BE(20)
    return width > 0 && height > 0 ? { width, height } : undefined
  } catch {
    return undefined
  }
}
