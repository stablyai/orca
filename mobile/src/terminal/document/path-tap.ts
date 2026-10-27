import type { TerminalDocumentScope } from './document-scope'
import { cellColToStringIndex, getLineText } from './cell-geometry'
import { viewportToCell } from './viewport-cell'
import {
  growSpacedPathRanges,
  trimTerminalPathBoundaryPunctuation,
  type TerminalPathTextRange
} from '../../../../src/shared/terminal-spaced-path-candidates'

// Bare filenames and spaced readings are valid candidates because the host checks existence.

export type TerminalPathCandidate = {
  pathText: string
  line: number | null
  column: number | null
}

const FILE_PATH_RE =
  // oxlint-disable-next-line no-useless-escape -- the document's text is pinned token for token; rewriting this changes the native program
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/]|(?=[A-Za-z0-9._-]*\.[A-Za-z0-9]))[A-Za-z0-9._~\-\/%+@\\()[\]]*(?::\d+)?(?::\d+)?/g

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

/** Readings that contain the tap, longest first; the host opens the first that exists. */
export function filePathCandidatesAtColumn(lineText: string, col: number): TerminalPathCandidate[] {
  const ranges: TerminalPathTextRange[] = []
  let tapsPlainPath = false
  FILE_PATH_RE.lastIndex = 0
  let match: RegExpExecArray | null
  // Why stop past the tap: a reading that starts after it cannot contain it.
  while ((match = FILE_PATH_RE.exec(lineText)) !== null && match.index <= col) {
    const raw = match[0]
    if (raw.length === 0) {
      FILE_PATH_RE.lastIndex += 1
      continue
    }
    const trimmed = trimTerminalPathBoundaryPunctuation(raw, match.index)
    if (!trimmed) {
      continue
    }
    ranges.push(trimmed)
    tapsPlainPath = tapsPlainPath || (col >= trimmed.startIndex && col < trimmed.endIndex)
    if (/[\\/]/.test(trimmed.text)) {
      ranges.push(...growSpacedPathRanges(lineText, trimmed, match.index + raw.length))
    }
  }
  // Why: a tap on prose a spaced guess spans must still reach the terminal as a click.
  if (!tapsPlainPath) {
    return []
  }
  const candidates: TerminalPathCandidate[] = []
  for (const range of ranges
    .filter((range) => col >= range.startIndex && col < range.endIndex)
    .sort((left, right) => right.text.length - left.text.length)) {
    const parsed = parsePathLineCol(range.text)
    if (parsed && !candidates.some((candidate) => candidate.pathText === parsed.pathText)) {
      candidates.push(parsed)
    }
  }
  return candidates
}

export function filePathCandidatesAtViewportPoint(
  scope: TerminalDocumentScope,
  originX: number,
  originY: number
) {
  const tapCell = viewportToCell(scope, originX, originY)
  if (!tapCell) {
    return []
  }
  // Convert wide-cell columns to string offsets before matching paths.
  return filePathCandidatesAtColumn(
    getLineText(scope, tapCell.row),
    cellColToStringIndex(scope, tapCell.row, tapCell.col)
  )
}
