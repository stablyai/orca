import type { TerminalDocumentScope } from './document-scope'
import { cellColToStringIndex, getLineText } from './cell-geometry'
import { viewportToCell } from './viewport-cell'

/**
 * File-path-under-tap detection.
 *
 * Mirrors the unit-tested `terminal-path-tap.ts`; keep the two in sync. That module is the source
 * of truth for the algorithm and has the regression tests.
 *
 * Matches both slash-bearing paths AND bare filenames with an extension (README.md,
 * src/index.ts:5) — like desktop, we propose candidates and let the host's
 * files.resolveTerminalPath existence check reject non-files. Agents often print a bare filename
 * (the markdown link target is consumed, leaving only the label text), so requiring a slash would
 * miss the common case.
 */

/** A span of a rendered line, in string indices. */
export type TerminalPathRange = { text: string; startIndex: number; endIndex: number }

/** A path proposed to the host, with the line and column suffixes it carried. */
export type TerminalPathCandidate = {
  pathText: string
  line: number | null
  column: number | null
}

const FILE_PATH_RE =
  // oxlint-disable-next-line no-useless-escape -- the document's text is pinned token for token; rewriting this changes the native program
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/]|(?=[A-Za-z0-9._-]*\.[A-Za-z0-9]))[A-Za-z0-9._~\-\/%+@\\()[\]]*(?::\d+)?(?::\d+)?/g
const SPACED_PATH_RE =
  // oxlint-disable-next-line no-useless-escape -- the document's text is pinned token for token; rewriting this changes the native program
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/])[^()[\]{}'",;<>|\`\r\n]+(?::\d+)?(?::\d+)?/g
const PATH_LEADING_TRIM: Record<string, number> = { '(': 1, '[': 1, '{': 1, '"': 1, "'": 1 }
const PATH_TRAILING_TRIM: Record<string, number> = {
  ')': 1,
  ']': 1,
  '}': 1,
  '"': 1,
  "'": 1,
  ',': 1,
  ';': 1,
  '.': 1
}

export function parsePathLineCol(value: string): TerminalPathCandidate | null {
  const m = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(value)
  if (!m) {
    return null
  }
  const pathText = m[1]
  const last = pathText.charAt(pathText.length - 1)
  if (!pathText || last === '/' || last === '\\') {
    return null
  }
  const line = m[2] ? Number.parseInt(m[2], 10) : null
  const column = m[3] ? Number.parseInt(m[3], 10) : null
  if ((line !== null && line < 1) || (column !== null && column < 1)) {
    return null
  }
  return { pathText: pathText, line: line, column: column }
}

export function trimPathBoundaryPunctuation(
  raw: string,
  rawStart: number
): TerminalPathRange | null {
  let start = 0,
    end = raw.length
  while (start < end && PATH_LEADING_TRIM[raw.charAt(start)]) {
    start += 1
  }
  while (end > start && PATH_TRAILING_TRIM[raw.charAt(end - 1)]) {
    end -= 1
  }
  if (start >= end) {
    return null
  }
  return { text: raw.slice(start, end), startIndex: rawStart + start, endIndex: rawStart + end }
}

export function hasSeparatorAfterWhitespace(text: string) {
  let sawWhitespace = false
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i)
    if (/\s/.test(ch)) {
      sawWhitespace = true
      continue
    }
    if (sawWhitespace && (ch === '/' || ch === '\\')) {
      return true
    }
  }
  return false
}

export function trimSpacedPathTrailingProse(
  range: TerminalPathRange,
  col?: number
): TerminalPathRange | null {
  // A line-end extension token only extends the span when the added segment
  // is path-like (contains a separator) — prose must not be swallowed.
  let selected: string | null = null
  const extensionPrefixPattern = /\.[A-Za-z0-9_+-]+(?::\d+)?(?::\d+)?(?=\s+|$)/g
  let match: RegExpExecArray | null
  while ((match = extensionPrefixPattern.exec(range.text)) !== null) {
    const end = match.index + match[0].length
    // Why `var`: the document declares this name twice in one function, which is one binding; two
    // block-scoped declarations would be a different program and esbuild renames the inner one.
    var text = range.text.slice(0, end)
    if (countPathStarts(text) > 1) {
      continue
    }
    if (
      end < range.text.length ||
      selected === null ||
      /[\\/]/.test(range.text.slice(selected.length, end))
    ) {
      selected = text
    }
  }
  if (selected) {
    if (col !== undefined && col >= range.startIndex + selected.length) {
      return null
    }
    return {
      text: selected,
      startIndex: range.startIndex,
      endIndex: range.startIndex + selected.length
    }
  }
  var text = range.text.replace(/\s+$/, '')
  return { text: text, startIndex: range.startIndex, endIndex: range.startIndex + text.length }
}

export function countPathStarts(text: string) {
  let count = 0
  const pathStartPattern = /(?:^|\s)(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/])/g
  while (pathStartPattern.exec(text) !== null) {
    count += 1
  }
  return count
}

export function hasSpacedPathExtension(text: string) {
  const range = trimSpacedPathTrailingProse({ text: text, startIndex: 0, endIndex: text.length })
  if (!range) {
    return false
  }
  const trimmed = range.text.replace(/\s+$/, '')
  return /\s/.test(trimmed) && /\.[A-Za-z0-9_+-]+(?::\d+)?(?::\d+)?$/.test(trimmed)
}

export function matchSpacedFilePathAtColumn(lineText: string, col: number) {
  SPACED_PATH_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SPACED_PATH_RE.exec(lineText)) !== null) {
    const trimmed = trimPathBoundaryPunctuation(match[0], match.index)
    if (
      !trimmed ||
      (!hasSeparatorAfterWhitespace(trimmed.text) && !hasSpacedPathExtension(trimmed.text))
    ) {
      continue
    }
    const candidate = trimSpacedPathTrailingProse(trimmed, col)
    if (!candidate) {
      continue
    }
    if (col < candidate.startIndex || col >= candidate.endIndex) {
      continue
    }
    const parsed = parsePathLineCol(candidate.text)
    if (parsed) {
      return parsed
    }
  }
  return null
}

export function matchFilePathAtColumn(lineText: string, col: number) {
  const spaced = matchSpacedFilePathAtColumn(lineText, col)
  if (spaced) {
    return spaced
  }
  FILE_PATH_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FILE_PATH_RE.exec(lineText)) !== null) {
    const raw = match[0]
    if (raw.length === 0) {
      FILE_PATH_RE.lastIndex += 1
      continue
    }
    const trimmed = trimPathBoundaryPunctuation(raw, match.index)
    if (!trimmed) {
      continue
    }
    if (col < trimmed.startIndex || col >= trimmed.endIndex) {
      continue
    }
    const parsed = parsePathLineCol(trimmed.text)
    if (parsed) {
      return parsed
    }
  }
  return null
}

// Returns the path candidate under the tap, or null. Query-only so the tap
// handler can try file detection before forwarding a mouse click — which lets
// file paths open even inside a mouse-tracking TUI. Relies on viewportToCell/
// getLineText from the host script scope.
export function filePathAtViewportPoint(
  scope: TerminalDocumentScope,
  originX: number,
  originY: number
) {
  const tapCell = viewportToCell(scope, originX, originY)
  if (!tapCell) {
    return null
  }
  // Map the cell column to a string index so wide chars (emoji/CJK) earlier on
  // the line don't shift the match column off the tapped path.
  return matchFilePathAtColumn(
    getLineText(scope, tapCell.row),
    cellColToStringIndex(scope, tapCell.row, tapCell.col)
  )
}
