// ~400-char page splitter at line boundaries (spec S5): a HUD never shows half a terminal
// line, so pages break only between lines, even if a single line exceeds the char budget.

export type HudTextPaginationOptions = {
  maxCharsPerPage?: number // default 400
  maxLinesPerPage?: number // default 9 (216px body / ~24px line height)
}

export const DEFAULT_MAX_CHARS_PER_PAGE = 400
export const DEFAULT_MAX_LINES_PER_PAGE = 9

export function paginateHudBody(lines: string[], opts?: HudTextPaginationOptions): string[] {
  const maxChars = opts?.maxCharsPerPage ?? DEFAULT_MAX_CHARS_PER_PAGE
  const maxLines = opts?.maxLinesPerPage ?? DEFAULT_MAX_LINES_PER_PAGE

  if (lines.length === 0) {
    return ['']
  }

  const pages: string[] = []
  let currentLines: string[] = []
  let currentChars = 0

  for (const line of lines) {
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
