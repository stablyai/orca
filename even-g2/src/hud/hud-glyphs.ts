// Status glyph vocabulary verified present in the firmware font (spec S5), plus the
// fullwidth-column aligner: the proportional LVGL font makes ASCII spaces unusable for
// tabular alignment, so columns pad with U+3000 IDEOGRAPHIC SPACE instead.

export const GLYPH_WORKING = '▶'
export const GLYPH_NEEDS_INPUT = '▲'
export const GLYPH_NEEDS_INPUT_PULSE = '!' // header pulse alongside GLYPH_NEEDS_INPUT
export const GLYPH_DONE = '●'
export const GLYPH_IDLE = '○'
export const GLYPH_DISCONNECTED = '◇'
export const GLYPH_CURSOR_PREFIX = '>' // selection cursor prefix on text layouts
export const GLYPH_PROGRESS_FILLED = '━'
export const GLYPH_PROGRESS_EMPTY = '─'

const IDEOGRAPHIC_SPACE = '　'
const ELLIPSIS = '…'

/**
 * Aligns tabular rows to fixed column widths (in code units) using ideographic-space
 * padding. Glyph + name text stays ASCII; only the padding is fullwidth. Cells longer than
 * their column width are truncated with an ellipsis so every column is exactly `width`
 * code units wide across every row.
 */
export function toFullwidthColumns(rows: string[][], widths: number[]): string[] {
  return rows.map((row) =>
    row
      .map((cell, i) => {
        const width = widths[i] ?? cell.length
        if (cell.length > width) {
          return width > 1 ? cell.slice(0, width - 1) + ELLIPSIS : cell.slice(0, width)
        }
        return cell + IDEOGRAPHIC_SPACE.repeat(width - cell.length)
      })
      .join('')
  )
}
