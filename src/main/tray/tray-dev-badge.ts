import { nativeImage, type NativeImage } from 'electron'

// Five-pixel DEV text fits the empty glyph area without widening the production 14pt status item.
const DEV_BADGE_ROWS = ['##..###.#.#', '#.#.#...#.#', '#.#.##..#.#', '#.#.#...#.#', '##..###..#.']
const BADGE_OFFSET_X = 0
const BADGE_OFFSET_Y = 3
// Clear an antialias margin so the tail does not turn DEV into DEU.
const BADGE_CLEAR_MARGIN = 1

/** Stamp template-black/alpha pixels so macOS and attention tint preserve the dev badge across themes; empty images stay unchanged. */
export function stampTrayDevBadge(base: NativeImage, scaleFactor = 1): NativeImage {
  const { width, height } = base.getSize()
  if (width <= 0 || height <= 0) {
    return base
  }

  const bitmap = Buffer.from(base.toBitmap({ scaleFactor }))
  const pixelWidth = width * scaleFactor
  const pixelHeight = height * scaleFactor

  const clearLeft = (BADGE_OFFSET_X - BADGE_CLEAR_MARGIN) * scaleFactor
  const clearTop = (BADGE_OFFSET_Y - BADGE_CLEAR_MARGIN) * scaleFactor
  const clearRight = (BADGE_OFFSET_X + DEV_BADGE_ROWS[0].length + BADGE_CLEAR_MARGIN) * scaleFactor
  const clearBottom = (BADGE_OFFSET_Y + DEV_BADGE_ROWS.length + BADGE_CLEAR_MARGIN) * scaleFactor
  for (let y = Math.max(0, clearTop); y < Math.min(pixelHeight, clearBottom); y++) {
    for (let x = Math.max(0, clearLeft); x < Math.min(pixelWidth, clearRight); x++) {
      bitmap.fill(0x00, (y * pixelWidth + x) * 4, (y * pixelWidth + x) * 4 + 4)
    }
  }

  for (let row = 0; row < DEV_BADGE_ROWS.length; row++) {
    const pattern = DEV_BADGE_ROWS[row]
    for (let col = 0; col < pattern.length; col++) {
      if (pattern[col] !== '#') {
        continue
      }
      // Scale badge pixels so Retina and 1x keep the same physical size.
      for (let dy = 0; dy < scaleFactor; dy++) {
        for (let dx = 0; dx < scaleFactor; dx++) {
          const x = (BADGE_OFFSET_X + col) * scaleFactor + dx
          const y = (BADGE_OFFSET_Y + row) * scaleFactor + dy
          if (x >= pixelWidth || y >= pixelHeight) {
            continue
          }
          const offset = (y * pixelWidth + x) * 4
          bitmap[offset] = 0x00
          bitmap[offset + 1] = 0x00
          bitmap[offset + 2] = 0x00
          bitmap[offset + 3] = 0xff
        }
      }
    }
  }

  return nativeImage.createFromBitmap(bitmap, { width: pixelWidth, height: pixelHeight })
}
