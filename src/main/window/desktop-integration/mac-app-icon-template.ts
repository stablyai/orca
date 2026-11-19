// Apple's macOS app icon grid at 1024px: an 824px continuous-corner tile with a soft drop shadow.
const GRID_SIDE = 1024
const TILE_INSET = 100
// Corner and shadow are fitted to the icon actool renders from resources/icon-source/icon.icon.
const CORNER_EXTENT_RATIO = 216 / 824
const CORNER_EXPONENT = 2.4
const SHADOW_OFFSET_Y = 8
const SHADOW_SIGMA = 16
const SHADOW_OPACITY = 0.25
const CORNER_SAMPLE_RATIO = 0.02
// Tolerates near-opaque export noise (alpha 250–254); anything lower counts as see-through.
const OPAQUE_CORNER_ALPHA = 250

export type MacAppIconTileGeometry = {
  side: number
  tileOffset: number
  tileSide: number
}

export function getMacAppIconTileGeometry(side: number): MacAppIconTileGeometry {
  const tileOffset = Math.round((side * TILE_INSET) / GRID_SIDE)
  return { side, tileOffset, tileSide: side - 2 * tileOffset }
}

/** True when every sampled corner pixel has alpha ≥ 250, i.e. the art is a full-bleed square, not an icon shape. */
export function isFullBleedIconBitmap(bitmap: Uint8Array, side: number): boolean {
  const patch = Math.max(1, Math.round(side * CORNER_SAMPLE_RATIO))
  for (const originY of [0, side - patch]) {
    for (const originX of [0, side - patch]) {
      for (let y = originY; y < originY + patch; y++) {
        for (let x = originX; x < originX + patch; x++) {
          if (bitmap[(y * side + x) * 4 + 3] < OPAQUE_CORNER_ALPHA) {
            return false
          }
        }
      }
    }
  }
  return true
}

function tileSignedDistance(x: number, y: number, half: number, cornerExtent: number): number {
  const qx = Math.abs(x) - (half - cornerExtent)
  const qy = Math.abs(y) - (half - cornerExtent)
  if (qx > 0 && qy > 0) {
    const f = (qx / cornerExtent) ** CORNER_EXPONENT + (qy / cornerExtent) ** CORNER_EXPONENT
    return (f ** (1 / CORNER_EXPONENT) - 1) * cornerExtent
  }
  return Math.max(qx, qy) - cornerExtent
}

// Abramowitz–Stegun 7.1.26; precise to ~1e-7, far below one 8-bit alpha step.
function erfc(value: number): number {
  const z = Math.abs(value)
  const t = 1 / (1 + 0.3275911 * z)
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
  const result = poly * Math.exp(-z * z)
  return value >= 0 ? result : 2 - result
}

/**
 * Masks premultiplied RGBA/BGRA tile art (already scaled to `tileSide`) into the macOS icon shape
 * on a transparent `side` canvas with Apple's drop shadow. Channel order is preserved.
 */
export function composeMacAppIconBitmap(
  tileBitmap: Uint8Array,
  geometry: MacAppIconTileGeometry
): Uint8Array {
  const { side, tileOffset, tileSide } = geometry
  const scale = side / GRID_SIDE
  const half = tileSide / 2
  const center = side / 2
  const cornerExtent = tileSide * CORNER_EXTENT_RATIO
  const shadowOffset = SHADOW_OFFSET_Y * scale
  const shadowSigma = SHADOW_SIGMA * scale
  const shadowReach = shadowSigma * 4
  const output = new Uint8Array(side * side * 4)
  for (let y = 0; y < side; y++) {
    const dy = y + 0.5 - center
    for (let x = 0; x < side; x++) {
      const dx = x + 0.5 - center
      const distance = tileSignedDistance(dx, dy, half, cornerExtent)
      const coverage = Math.min(1, Math.max(0, 0.5 - distance))
      const index = (y * side + x) * 4
      let artAlpha = 0
      if (coverage > 0) {
        const tileX = x - tileOffset
        const tileY = y - tileOffset
        if (tileX >= 0 && tileY >= 0 && tileX < tileSide && tileY < tileSide) {
          const source = (tileY * tileSide + tileX) * 4
          output[index] = Math.round(tileBitmap[source] * coverage)
          output[index + 1] = Math.round(tileBitmap[source + 1] * coverage)
          output[index + 2] = Math.round(tileBitmap[source + 2] * coverage)
          artAlpha = (tileBitmap[source + 3] / 255) * coverage
        }
      }
      let shadowAlpha = 0
      if (artAlpha < 1) {
        const shadowDistance = tileSignedDistance(dx, dy - shadowOffset, half, cornerExtent)
        if (shadowDistance < shadowReach) {
          shadowAlpha = SHADOW_OPACITY * 0.5 * erfc(shadowDistance / (shadowSigma * Math.SQRT2))
        }
      }
      // Premultiplied black shadow under the art only adds alpha.
      output[index + 3] = Math.round(255 * (artAlpha + shadowAlpha * (1 - artAlpha)))
    }
  }
  return output
}
