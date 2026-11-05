import { nativeImage, type NativeImage } from 'electron'

// Match renderer attention/unread amber-500, including FloatingTerminalToggleButton.
const DOT_RGB = { r: 0xf5, g: 0x9e, b: 0x0b }
// A near-white halo separates the dot from the icon glyph on any tray theme.
const RING_RGB = { r: 0xff, g: 0xff, b: 0xff }

/** Non-template attention images need literal glyph pixels because macOS no longer tints them. */
export function tintTrayTemplateForAttention(
  base: NativeImage,
  useLightGlyph: boolean,
  scaleFactor = 1
): NativeImage {
  const { width, height } = base.getSize()
  if (width <= 0 || height <= 0) {
    return base
  }

  const bitmap = Buffer.from(base.toBitmap({ scaleFactor }))
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    // Premultiplied alpha uses coverage for light channels; 0xff would overbrighten antialiased edges.
    const channel = useLightGlyph ? bitmap[offset + 3] : 0x00
    bitmap[offset] = channel
    bitmap[offset + 1] = channel
    bitmap[offset + 2] = channel
  }

  return nativeImage.createFromBitmap(bitmap, {
    width: width * scaleFactor,
    height: height * scaleFactor
  })
}

/** Composite BGRA directly because NativeImage has no layering API; preserve the base on empty input so tray creation never blanks it. */
export function composeTrayAttentionIcon(base: NativeImage): NativeImage {
  const { width, height } = base.getSize()
  if (width <= 0 || height <= 0) {
    return base
  }

  // Keep Electron's BGRA format through the bitmap round trip.
  const bitmap = Buffer.from(base.toBitmap())
  const dotRadius = Math.max(2, Math.round(Math.min(width, height) * 0.2))
  const ringRadius = dotRadius + 1
  // Top-right badge preserves the main bottom-left glyph; only the outer ring may clip a corner pixel.
  const centerX = width - 1 - dotRadius
  const centerY = dotRadius
  const dotRadiusSq = dotRadius * dotRadius
  const ringRadiusSq = ringRadius * ringRadius

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - centerX
      const dy = y - centerY
      const distSq = dx * dx + dy * dy
      if (distSq > ringRadiusSq) {
        continue
      }
      const offset = (y * width + x) * 4
      const color = distSq <= dotRadiusSq ? DOT_RGB : RING_RGB
      bitmap[offset] = color.b
      bitmap[offset + 1] = color.g
      bitmap[offset + 2] = color.r
      bitmap[offset + 3] = 0xff
    }
  }

  return nativeImage.createFromBitmap(bitmap, { width, height })
}
