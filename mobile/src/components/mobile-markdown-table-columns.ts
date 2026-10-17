import { spacing } from '../theme/mobile-theme'

// Per-glyph advances at the 12px table font, measured on agent tables: 6.4 regular and 6.9 bold
// on average, and up to 8.7 for a bold word. A wrong guess wraps text; it cannot misalign columns.
const AVERAGE_GLYPH_WIDTH = 7
const WIDEST_GLYPH_WIDTH = 9
// Horizontal padding plus the right border of `styles.tableCell`.
const CELL_CHROME = spacing.md * 2 + 1
const MIN_COLUMN_WIDTH = 72
const MAX_COLUMN_WIDTH = 220
const WHITESPACE = /\s/

function cellContentWidth(text: string): number {
  let columns = 0
  let word = 0
  let longestWord = 0
  for (const char of text) {
    // CJK, kana, Hangul, fullwidth forms and emoji draw about two Latin glyphs wide.
    const wide = char.codePointAt(0)! >= 0x2e80
    columns += wide ? 2 : 1
    // Lines break at spaces and around wide glyphs; only a longer unbroken run splits mid-word.
    word = wide || WHITESPACE.test(char) ? 0 : word + 1
    longestWord = Math.max(longestWord, word)
  }
  return Math.max(columns * AVERAGE_GLYPH_WIDTH, longestWord * WIDEST_GLYPH_WIDTH)
}

/** One width per header column, sized to the column's widest cell. `rows` holds each cell's
 *  drawn text, header row first. */
export function mobileMarkdownTableColumnWidths(
  rows: readonly string[][],
  { availableWidth = 0, textScale = 1 }: { availableWidth?: number; textScale?: number } = {}
): number[] {
  const minimum = MIN_COLUMN_WIDTH * textScale
  const natural = (rows[0] ?? []).map((_, column) => {
    let widest = 0
    for (const row of rows) {
      widest = Math.max(widest, cellContentWidth(row[column] ?? ''))
    }
    return Math.min(
      MAX_COLUMN_WIDTH * textScale,
      Math.max(minimum, widest * textScale + CELL_CHROME)
    )
  })
  if (!natural.length || availableWidth <= 0) {
    return natural
  }
  const total = natural.reduce((sum, width) => sum + width, 0)
  if (availableWidth >= total) {
    return natural.map((width) => width + (availableWidth - total) / natural.length)
  }
  // Preserve readable content widths; the table owns horizontal overflow.
  return natural
}
