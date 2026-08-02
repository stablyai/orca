import { nativeImage, type NativeImage } from 'electron'

// Why: a 5px-tall pixel-caps "DEV" is the smallest text that stays legible in
// the 14pt menu-bar template; it fills the empty area left of the orca glyph
// so the status item keeps the exact production footprint.
const DEV_BADGE_ROWS = ['##..###.#.#', '#.#.#...#.#', '#.#.##..#.#', '#.#.#...#.#', '##..###..#.']
const BADGE_OFFSET_X = 0
const BADGE_OFFSET_Y = 3
// Why: the orca tail's antialiased pixels touch the V's right stroke and make
// "DEV" read as "DEU"; clearing a margin around the badge keeps it legible.
const BADGE_CLEAR_MARGIN = 1

/**
 * Returns a copy of the menu-bar template with a "DEV" pixel-text badge
 * stamped left of the glyph. Badge pixels are template black (#000 + alpha),
 * so macOS tints them with the glyph in both menu-bar themes and the attention
 * tint path inherits the badge unchanged. Returns `base` untouched when the
 * image has no pixels.
 */
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
      // Why: replicate each badge pixel scaleFactor times so the Retina
      // representation shows the same physical badge as the 1x one.
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
