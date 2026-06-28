/** Low-level ANSI output primitives for the manual screen compositor. We own
 *  the terminal directly (herdr-style) instead of going through Ink, so every
 *  cursor move, clear, and SGR style is emitted by hand from here. */

export const RESET = '\x1b[0m'
export const HIDE_CURSOR = '\x1b[?25l'
export const SHOW_CURSOR = '\x1b[?25h'
export const CLEAR_SCREEN = '\x1b[2J\x1b[H'
export const ALT_SCREEN_ENTER = '\x1b[?1049h'
export const ALT_SCREEN_LEAVE = '\x1b[?1049l'
/** Disable/enable terminal auto-wrap (DECAWM). We own the screen and place every
 *  row by absolute cursor moves, so wrapping must be OFF — otherwise a viewport
 *  line whose true display width exceeds our cell count (e.g. an emoji we measure
 *  as one cell) overflows the edge, wraps, and shifts the whole layout. With it
 *  off the terminal clips at the edge instead, like every full-screen TUI. */
export const AUTOWRAP_OFF = '\x1b[?7l'
export const AUTOWRAP_ON = '\x1b[?7h'
/** Clear from the cursor to the end of the current physical row. */
export const CLEAR_TO_EOL = '\x1b[K'

/** Move the cursor to a 1-based (row, col). Compositor rows/cols are 0-based, so
 *  callers add one at the boundary. */
export function cursorTo(row: number, col: number): string {
  return `\x1b[${row + 1};${col + 1}H`
}

export type ColorName =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'gray'
  | 'orange'

const FG: Record<ColorName, number> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
  orange: 33 // unused: orange uses the 256-color path below
}

// Colors with no 16-color slot, emitted via the 256-color palette (38;5;n /
// 48;5;n) instead of the base 30-37 / 40-47 codes.
const XTERM_256: Partial<Record<ColorName, number>> = { orange: 208 }

export type TextStyle = {
  fg?: ColorName
  bg?: ColorName
  bold?: boolean
  dim?: boolean
  inverse?: boolean
}

/** Wrap text in an SGR run terminated by a reset. `useColor` gates only color
 *  (NO_COLOR keeps bold/inverse so structure survives on monochrome terms). */
export function style(text: string, spec: TextStyle, useColor = true): string {
  const codes: number[] = []
  if (spec.bold) {
    codes.push(1)
  }
  if (spec.dim) {
    codes.push(2)
  }
  if (spec.inverse) {
    codes.push(7)
  }
  if (useColor && spec.fg) {
    const x = XTERM_256[spec.fg]
    codes.push(...(x === undefined ? [FG[spec.fg]] : [38, 5, x]))
  }
  if (useColor && spec.bg) {
    const x = XTERM_256[spec.bg]
    codes.push(...(x === undefined ? [FG[spec.bg] + 10] : [48, 5, x]))
  }
  if (codes.length === 0) {
    return text
  }
  return `\x1b[${codes.join(';')}m${text}${RESET}`
}
