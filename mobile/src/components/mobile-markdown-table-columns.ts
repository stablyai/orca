import { spacing } from '../theme/mobile-theme'

// Measured 12px advances: 6.4 regular, 6.9 bold, up to 8.7 per bold glyph. Estimation affects wrapping, never column alignment.
const AVERAGE_GLYPH_WIDTH = 7
const WIDEST_GLYPH_WIDTH = 9
// Horizontal padding plus the right border of `styles.tableCell`.
const CELL_CHROME = spacing.md * 2 + 1
const MIN_COLUMN_WIDTH = 48
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
 *  drawn text, header row first. The reader's zoom scales the text, not the cell padding. */
export function mobileMarkdownTableColumnWidths(
  rows: readonly string[][],
  textScale: number
): number[] {
  return (rows[0] ?? []).map((_, column) => {
    let widest = 0
    for (const row of rows) {
      widest = Math.max(widest, cellContentWidth(row[column] ?? ''))
    }
    return Math.min(
      MAX_COLUMN_WIDTH * textScale,
      Math.max(MIN_COLUMN_WIDTH * textScale, widest * textScale + CELL_CHROME)
    )
  })
}
