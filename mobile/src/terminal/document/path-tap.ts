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
export type TerminalPathCandidate = { pathText: string; line: number | null; column: number | null }

const FILE_PATH_RE =
  // oxlint-disable-next-line no-useless-escape -- the document's text is pinned token for token; rewriting this changes the native program
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/]|(?=[A-Za-z0-9._-]*\.[A-Za-z0-9]))[A-Za-z0-9._~\-\/%+@\\()[\]]*(?::\d+)?(?::\d+)?/g
const SPACED_PATH_RE =
  // oxlint-disable-next-line no-useless-escape -- the document's text is pinned token for token; rewriting this changes the native program
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/])[^()[\]{}'",;<>|\`\r\n]+(?::\d+)?(?::\d+)?/g
const PATH_LEADING_TRIM: Record<string, number> = { '(': 1, '[': 1, '{': 1, '"': 1, "'": 1 }
const PATH_TRAILING_TRIM: Record<string, number> = { ')': 1, ']': 1, '}': 1, '"': 1, "'": 1, ',': 1, ';': 1, '.': 1 }

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

export function trimPathBoundaryPunctuation(raw: string, rawStart: number): TerminalPathRange | null {
  let start = 0, end = raw.length
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
    if (!candidate || col < candidate.startIndex || col >= candidate.endIndex) {
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
    if (!trimmed || col < trimmed.startIndex || col >= trimmed.endIndex) {
      continue
    }
    const parsed = parsePathLineCol(trimmed.text)
    if (parsed) {
      return parsed
    }
  }
  return null
}

export type TerminalWrappedLineRow = { text: string; isWrapped?: boolean }

type WrappedRowSlice = {
  content: string
  contentStart: number
  contentEnd: number
  leadingToken: string
  trailingToken: string
}

function sliceWrappedRow(text: string): WrappedRowSlice {
  const leftMatch = /^[ \t]*[│┃║╎╏┆┇┊┋|]?[ \t]*/.exec(text)
  const contentStart = leftMatch ? leftMatch[0].length : 0
  const rightMatch = /[ \t]*[│┃║╎╏┆┇┊┋|]?[ \t]*$/.exec(text)
  const contentEnd = Math.max(contentStart, text.length - (rightMatch ? rightMatch[0].length : 0))
  const content = text.slice(contentStart, contentEnd)
  const leadingMatch = /^[A-Za-z0-9._~\-/%+@:\\()[\]]+/.exec(content)
  const trailingMatch = /[A-Za-z0-9._~\-/%+@:\\()[\]]+$/.exec(content)
  return { content, contentStart, contentEnd, leadingToken: leadingMatch ? leadingMatch[0] : '', trailingToken: trailingMatch ? trailingMatch[0] : '' }
}

function canRowContinueWrappedPath(prev: WrappedRowSlice, next: WrappedRowSlice) {
  if (
    !prev.trailingToken ||
    !next.leadingToken ||
    (next.leadingToken === '-' && (next.content.length === 1 || /\s/.test(next.content.charAt(1)))) ||
    /^(?:~[\\/]|\/{2}|\\\\|\.{1,2}[\\/]|[A-Za-z]:[\\/])/.test(next.leadingToken)
  ) {
    return false
  }
  if (
    /\.[A-Za-z0-9_+-]+(?::\d+)*$/.test(prev.trailingToken) &&
    !/[\\/]\.[A-Za-z0-9_+-]+$/.test(prev.trailingToken)
  ) {
    return (
      prev.contentEnd >= 35 &&
      /\.[a-z0-9]{1,2}$/.test(prev.trailingToken) &&
      /^[a-z0-9]{1,4}(?::\d+)*$/.test(next.leadingToken)
    )
  }
  return true
}

export function matchWrappedFilePathAtRowColumn(
  rows: readonly TerminalWrappedLineRow[],
  tappedRowIndex: number,
  tappedCol: number
) {
  const tappedRow = rows[tappedRowIndex]
  if (!tappedRow) {
    return null
  }
  let softStart = tappedRowIndex
  while (softStart > 0 && rows[softStart]?.isWrapped) {
    softStart -= 1
  }
  let softEnd = tappedRowIndex
  while (softEnd + 1 < rows.length && rows[softEnd + 1]?.isWrapped) {
    softEnd += 1
  }
  if (softEnd > softStart) {
    let joinedText = ''
    let joinedCol = tappedCol
    for (let i = softStart; i <= softEnd; i += 1) {
      const rowText = rows[i] ? rows[i].text : ''
      const segment = i < softEnd ? rowText.replace(/\s+$/, '') : rowText
      if (i === tappedRowIndex) {
        joinedCol = joinedText.length + Math.min(tappedCol, segment.length)
      }
      joinedText += segment
    }
    const softMatched = matchFilePathAtColumn(joinedText, joinedCol)
    if (softMatched) {
      return softMatched
    }
  }
  const slices = rows.map((row) => sliceWrappedRow(row.text))
  const tappedSlice = slices[tappedRowIndex]
  if (tappedSlice && tappedCol >= tappedSlice.contentStart && tappedCol < tappedSlice.contentEnd) {
    let hardStart = tappedRowIndex
    while (
      hardStart > 0 &&
      canRowContinueWrappedPath(slices[hardStart - 1]!, slices[hardStart]!) &&
      (hardStart === tappedRowIndex ||
        slices[hardStart]!.leadingToken.length === slices[hardStart]!.content.length)
    ) {
      hardStart -= 1
    }
    let hardEnd = tappedRowIndex
    while (
      hardEnd + 1 < slices.length &&
      canRowContinueWrappedPath(slices[hardEnd]!, slices[hardEnd + 1]!) &&
      (hardEnd === hardStart ||
        slices[hardEnd]!.trailingToken.length === slices[hardEnd]!.content.length)
    ) {
      hardEnd += 1
    }
    if (hardEnd > hardStart) {
      let joinedText = ''
      let joinedCol = 0
      for (let i = hardStart; i <= hardEnd; i += 1) {
        const slice = slices[i]!
        if (i === tappedRowIndex) {
          joinedCol = joinedText.length + (tappedCol - slice.contentStart)
        }
        joinedText += slice.content
      }
      const hardMatched = matchFilePathAtColumn(joinedText, joinedCol)
      if (hardMatched && /[\\/]/.test(hardMatched.pathText)) {
        return hardMatched
      }
    }
  }
  return matchFilePathAtColumn(tappedRow.text, tappedCol)
}

export function filePathAtViewportPoint(
  scope: TerminalDocumentScope,
  originX: number,
  originY: number
) {
  const tapCell = viewportToCell(scope, originX, originY)
  if (!tapCell || !scope.term) {
    return null
  }
  const active = scope.term.buffer.active
  const startRow = Math.max(0, tapCell.row - 6)
  const endRow = Math.min(Math.max(active.length - 1, tapCell.row + 6), tapCell.row + 6)
  const rows: TerminalWrappedLineRow[] = []
  let tappedRowIndex = 0
  for (let row = startRow; row <= endRow; row += 1) {
    const line = active.getLine(row)
    if (!line && row !== tapCell.row) {
      if (row < tapCell.row) {
        continue
      }
      break
    }
    if (row === tapCell.row) {
      tappedRowIndex = rows.length
    }
    rows.push({ text: getLineText(scope, row), isWrapped: Boolean(line && line.isWrapped) })
  }
  return matchWrappedFilePathAtRowColumn(
    rows,
    tappedRowIndex,
    cellColToStringIndex(scope, tapCell.row, tapCell.col)
  )
}
