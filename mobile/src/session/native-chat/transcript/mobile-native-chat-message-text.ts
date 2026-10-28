const FONT_SCALE_MIN = 0.8
const FONT_SCALE_MAX = 1.8

function clampFontScale(scale: number): number {
  if (Number.isNaN(scale)) {
    return 1
  }
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, scale))
}

export const FONT_SCALE_STEP = 0.05

// Quantize pinch changes because each fontScale remeasures the whole list; frame-level updates can repaint recycled iOS paragraphs with stale clipped content.
export function quantizeFontScale(scale: number): number {
  if (Number.isNaN(scale)) {
    return 1
  }
  const stepped = Math.round(clampFontScale(scale) / FONT_SCALE_STEP) * FONT_SCALE_STEP
  // Re-clamp: rounding can push the outermost step past the bound.
  return clampFontScale(Number(stepped.toFixed(2)))
}
