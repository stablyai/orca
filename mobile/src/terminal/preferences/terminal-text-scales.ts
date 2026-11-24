// Keep presets independent of storage imports so the WebView bundle cannot pull in AsyncStorage.
// The stored text scale is points over 13 pt; Settings, pinch and storage all snap it to a whole point.
export const TERMINAL_BASE_FONT_PX = 13
export const TERMINAL_MIN_FONT_PX = 8
export const TERMINAL_MAX_FONT_PX = 26

export function terminalFontPxForScale(scale: number): number {
  const px = Math.round(TERMINAL_BASE_FONT_PX * scale)
  return Number.isFinite(px)
    ? Math.min(TERMINAL_MAX_FONT_PX, Math.max(TERMINAL_MIN_FONT_PX, px))
    : TERMINAL_BASE_FONT_PX
}

export function terminalTextScaleForPx(px: number): number {
  return terminalFontPxForScale(px / TERMINAL_BASE_FONT_PX) / TERMINAL_BASE_FONT_PX
}

export const MIN_TERMINAL_TEXT_SCALE = TERMINAL_MIN_FONT_PX / TERMINAL_BASE_FONT_PX
export const MAX_TERMINAL_TEXT_SCALE = TERMINAL_MAX_FONT_PX / TERMINAL_BASE_FONT_PX

/** Snaps any scale, including a legacy 50–200% preset, to the nearest whole point in range. */
export function snapTerminalTextScale(scale: number): number {
  return terminalFontPxForScale(scale) / TERMINAL_BASE_FONT_PX
}

/** A resting two-finger touch drifts a few percent, so a pinch must move a whole point before the size changes. */
export function pinchedTerminalTextScale(current: number, pinched: number): number {
  return Math.abs(pinched - current) * TERMINAL_BASE_FONT_PX < 1
    ? current
    : snapTerminalTextScale(pinched)
}
