// Presets shared by the toolbar picker and pinch, which snaps to them so both persist one value.
export const MARKDOWN_TEXT_SCALES = [0.5, 0.65, 0.8, 1, 1.25, 1.5, 1.75, 2] as const

const MIN_SCALE = MARKDOWN_TEXT_SCALES[0]
const MAX_SCALE = MARKDOWN_TEXT_SCALES[MARKDOWN_TEXT_SCALES.length - 1]

export function clampMarkdownTextScale(scale: number): number {
  return Number.isNaN(scale) ? 1 : Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

export function snapMarkdownTextScale(scale: number): number {
  const clamped = clampMarkdownTextScale(scale)
  return MARKDOWN_TEXT_SCALES.reduce((closest, preset) =>
    Math.abs(preset - clamped) < Math.abs(closest - clamped) ? preset : closest
  )
}

// Live pinch values move in 0.05 steps so a drag re-renders a few times, not per frame.
export function quantizeLiveMarkdownTextScale(scale: number): number {
  return Math.round(clampMarkdownTextScale(scale) * 20) / 20
}
