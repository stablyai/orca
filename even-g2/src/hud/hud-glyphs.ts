// Status glyph vocabulary verified present in the firmware font (spec S5), plus a
// middle-ellipsis helper for worktree names.
//
// HIGH #5: the old fullwidth-column aligner (equal-code-unit padding via U+3000 IDEOGRAPHIC
// SPACE) produced ragged-looking rows on the proportional LVGL font anyway, and its tail
// truncation regularly ate the one suffix that told two similarly-named worktrees apart (e.g.
// "payments-service-retry" vs "payments-service-final" both collapse to the same 20-char head).
// Dashboard rows are now a single simple line (dashboard-screen.ts) and names are
// middle-ellipsized instead, so the truncation always keeps a name's distinguishing tail.

export const GLYPH_WORKING = '▶'
export const GLYPH_NEEDS_INPUT = '▲'
export const GLYPH_NEEDS_INPUT_PULSE = '!' // header pulse alongside GLYPH_NEEDS_INPUT
export const GLYPH_DONE = '●'
export const GLYPH_IDLE = '○'
export const GLYPH_DISCONNECTED = '◇'
export const GLYPH_CURSOR_PREFIX = '>' // selection cursor prefix on text layouts
export const GLYPH_PROGRESS_FILLED = '━'
export const GLYPH_PROGRESS_EMPTY = '─'

const ELLIPSIS = '…'

/**
 * Shortens `name` to at most `max` chars by cutting the middle and keeping head+tail. A
 * worktree name's distinguishing detail (a branch/ticket suffix on an otherwise-shared prefix)
 * is far more often at the end than a tail-truncating ellipsis preserves. The tail gets any odd
 * leftover char of the kept budget, since suffixes tend to carry the distinguishing part.
 */
export function middleEllipsize(name: string, max: number): string {
  if (name.length <= max) {
    return name
  }
  if (max <= 1) {
    return name.slice(0, Math.max(max, 0))
  }
  const keep = max - 1
  const headLen = Math.floor(keep / 2)
  const tailLen = keep - headLen
  return `${name.slice(0, headLen)}${ELLIPSIS}${name.slice(name.length - tailLen)}`
}
