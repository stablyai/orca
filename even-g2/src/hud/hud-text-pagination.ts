// ~400-char page splitter at line boundaries (spec S5): a HUD never shows half a terminal
// line, so pages break only between lines, even if a single line exceeds the char budget.
//
// Finding #19: line-count budgets alone undercount a page's actual on-glass footprint — a
// single long line still occupies multiple visual rows. `maxGlyphsPerLine` (opt-in, so the
// existing "one line never splits" contract above stays intact by default) pre-wraps lines to a
// conservative measured glyph width before the line/char budgets are ever applied, so a long
// line is counted as the multiple rows it will actually render as. `reservedLines` shrinks the
// per-page line budget so callers (e.g. the ask screen's option strip) can guarantee their own
// controls still fit alongside a full page of body text.
//
// Integrator note: header/footer are single-visual-line budgets enforced by the screen's page
// spec, not by this splitter — hud-page-spec.ts (owned by another unit) is where header/footer
// truncation-to-one-line should be enforced; this module only paginates the body.

export type HudTextPaginationOptions = {
  maxCharsPerPage?: number // default 400
  maxLinesPerPage?: number // default 9 (216px body / ~24px line height)
  /** Conservative max glyphs per visual row. When set, lines are wrapped to this width before
   *  pagination so a long line counts as the multiple visual rows it will actually render as. */
  maxGlyphsPerLine?: number
  /** Lines to reserve for controls the caller renders alongside the body (e.g. an option strip),
   *  subtracted from maxLinesPerPage so the page and those controls both fit on-screen. */
  reservedLines?: number
}

export const DEFAULT_MAX_CHARS_PER_PAGE = 400
export const DEFAULT_MAX_LINES_PER_PAGE = 9

function wrapToGlyphWidth(lines: string[], maxGlyphs: number): string[] {
  if (maxGlyphs <= 0) {
    return lines
  }
  const wrapped: string[] = []
  for (const line of lines) {
    if (line.length <= maxGlyphs) {
      wrapped.push(line)
      continue
    }
    for (let i = 0; i < line.length; i += maxGlyphs) {
      wrapped.push(line.slice(i, i + maxGlyphs))
    }
  }
  return wrapped
}

export function paginateHudBody(lines: string[], opts?: HudTextPaginationOptions): string[] {
  const maxChars = opts?.maxCharsPerPage ?? DEFAULT_MAX_CHARS_PER_PAGE
  const reservedLines = Math.max(0, opts?.reservedLines ?? 0)
  const maxLines = Math.max(
    1,
    (opts?.maxLinesPerPage ?? DEFAULT_MAX_LINES_PER_PAGE) - reservedLines
  )
  const wrappedLines = opts?.maxGlyphsPerLine
    ? wrapToGlyphWidth(lines, opts.maxGlyphsPerLine)
    : lines

  if (wrappedLines.length === 0) {
    return ['']
  }

  const pages: string[] = []
  let currentLines: string[] = []
  let currentChars = 0

  for (const line of wrappedLines) {
    const wouldBeChars = currentLines.length === 0 ? line.length : currentChars + 1 + line.length
    const wouldOverflow =
      currentLines.length > 0 && (currentLines.length + 1 > maxLines || wouldBeChars > maxChars)

    if (wouldOverflow) {
      pages.push(currentLines.join('\n'))
      currentLines = [line]
      currentChars = line.length
    } else {
      currentLines.push(line)
      currentChars = wouldBeChars
    }
  }

  if (currentLines.length > 0) {
    pages.push(currentLines.join('\n'))
  }

  return pages
}
