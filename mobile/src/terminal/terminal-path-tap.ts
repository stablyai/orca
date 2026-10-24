// File-path detection for a single tap in the terminal. Mirrors the desktop
// link detection (src/renderer/src/lib/terminal-links.ts) but only finds the
// one path span containing the tapped column — mobile opens a tapped path, it
// does not render hover links over the whole line.

import {
  parseFileLinkLocation,
  type ParsedFileLinkLocation
} from '../../../src/shared/file-link-location'

export type TappedFilePath = ParsedFileLinkLocation

// Separator-anchored path tokens (absolute, relative, ~/, drive-letter, UNC) OR
// a bare filename with an extension (README.md, index.ts), optionally suffixed
// with :line or :line:col. Like desktop, we propose candidates and let the host
// existence-check reject non-files — agents often print a bare filename, so
// requiring a slash would miss the common case.
const LOCAL_PATH_REGEX =
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/]|(?=[A-Za-z0-9._-]*\.[A-Za-z0-9]))[A-Za-z0-9._~\-/%+@\\()[\]]*(?:#(?:[Ll]|line-?)\d+(?:[Cc]\d+)?(?:-(?:[Ll]|line-?)?\d+(?:[Cc]\d+)?)?|(?::\d+(?:-\d+)?)(?::\d+)?)?/g
const SPACED_PATH_REGEX =
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/])[^()[\]{}'",;<>|`\r\n]+(?:#(?:[Ll]|line-?)\d+(?:[Cc]\d+)?(?:-(?:[Ll]|line-?)?\d+(?:[Cc]\d+)?)?|(?::\d+(?:-\d+)?)(?::\d+)?)?/g

const LEADING_TRIM_CHARS = new Set(['(', '[', '{', '"', "'"])
const TRAILING_TRIM_CHARS = new Set([')', ']', '}', '"', "'", ',', ';', '.'])

type Span = { startIndex: number; endIndex: number }

function trimBoundaryPunctuation(
  value: string,
  startIndex: number
): (Span & { text: string }) | null {
  let start = 0
  let end = value.length
  while (start < end && LEADING_TRIM_CHARS.has(value[start])) {
    start += 1
  }
  while (end > start && TRAILING_TRIM_CHARS.has(value[end - 1])) {
    end -= 1
  }
  if (start >= end) {
    return null
  }
  return {
    text: value.slice(start, end),
    startIndex: startIndex + start,
    endIndex: startIndex + end
  }
}

export function parsePathWithOptionalLineColumn(value: string): TappedFilePath | null {
  const parsed = parseFileLinkLocation(value)
  if (!parsed) {
    return null
  }
  const { pathText, line, column } = parsed
  // Reject a directory-only token (trailing separator) for either slash style.
  if (pathText.endsWith('/') || pathText.endsWith('\\')) {
    return null
  }
  return { pathText, line, column }
}

function hasSeparatorAfterWhitespace(text: string): boolean {
  let sawWhitespace = false
  for (const char of text) {
    if (/\s/.test(char)) {
      sawWhitespace = true
      continue
    }
    if (sawWhitespace && (char === '/' || char === '\\')) {
      return true
    }
  }
  return false
}

function trimSpacedPathTrailingProse(
  range: Span & { text: string },
  col?: number
): (Span & { text: string }) | null {
  // Why: a line-end extension token only extends the span when the added
  // segment is path-like (contains a separator) — "v1.2 reports/result.json"
  // extends, prose like "failed to start app.py" must not be swallowed.
  let selected: string | null = null
  const extensionPrefixPattern = /\.[A-Za-z0-9_+-]+(?::\d+)?(?::\d+)?(?=\s+|$)/g
  let match: RegExpExecArray | null
  while ((match = extensionPrefixPattern.exec(range.text)) !== null) {
    const end = match.index + match[0].length
    const text = range.text.slice(0, end)
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
  if (!selected) {
    const text = range.text.trimEnd()
    return {
      ...range,
      text,
      endIndex: range.startIndex + text.length
    }
  }
  if (col !== undefined && col >= range.startIndex + selected.length) {
    return null
  }
  return {
    text: selected,
    startIndex: range.startIndex,
    endIndex: range.startIndex + selected.length
  }
}

function countPathStarts(text: string): number {
  let count = 0
  for (const match of text.matchAll(/(?:^|\s)(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/])/g)) {
    void match
    count += 1
  }
  return count
}

function hasSpacedPathExtension(text: string): boolean {
  const trimmed = trimSpacedPathTrailingProse({
    text,
    startIndex: 0,
    endIndex: text.length
  })?.text.trimEnd()
  if (!trimmed) {
    return false
  }
  return /\s/.test(trimmed) && /\.[A-Za-z0-9_+-]+(?::\d+)?(?::\d+)?$/.test(trimmed)
}

function matchSpacedFilePathAtColumn(lineText: string, col: number): TappedFilePath | null {
  SPACED_PATH_REGEX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SPACED_PATH_REGEX.exec(lineText)) !== null) {
    const trimmed = trimBoundaryPunctuation(match[0], match.index)
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
    const parsed = parsePathWithOptionalLineColumn(candidate.text)
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
  stoppedBeforeBoxBorder: boolean
}

function sliceWrappedRow(text: string): WrappedRowSlice {
  const contentStart = /^[ \t]*[│┃║╎╏┆┇┊┋|]?[ \t]*/.exec(text)?.[0].length ?? 0
  const rightTrim = /[ \t]*[│┃║╎╏┆┇┊┋|]?[ \t]*$/.exec(text)?.[0].length ?? 0
  const contentEnd = Math.max(contentStart, text.length - rightTrim)
  const content = text.slice(contentStart, contentEnd)
  return {
    content,
    contentStart,
    contentEnd,
    leadingToken: /^[A-Za-z0-9._~\-/%+@:\\#()[\]]+/.exec(content)?.[0] ?? '',
    trailingToken: /[A-Za-z0-9._~\-/%+@:\\#()[\]]+$/.exec(content)?.[0] ?? '',
    stoppedBeforeBoxBorder: /[ \t]{3,}[│┃║╎╏┆┇┊┋|][ \t]*$/.test(text)
  }
}

function isFullRowPathToken(slice: WrappedRowSlice): boolean {
  return slice.leadingToken.length > 0 && slice.leadingToken.length === slice.content.length
}

function canRowStartWrappedPath(slice: WrappedRowSlice): boolean {
  return (
    Boolean(slice.trailingToken) &&
    (slice.trailingToken.length === slice.content.length || /[\\/]/.test(slice.trailingToken))
  )
}

function hasReachedWrapWidth(
  prev: WrappedRowSlice,
  next: WrappedRowSlice,
  terminalCols?: number
): boolean {
  if (prev.contentEnd < 35 || prev.stoppedBeforeBoxBorder) {
    return false
  }
  if (!terminalCols || terminalCols <= 35) {
    return true
  }
  const nextBreakIndex = next.leadingToken.indexOf('-')
  const hyphenWrapSlack = prev.trailingToken.endsWith('-')
    ? nextBreakIndex >= 0
      ? nextBreakIndex + 1
      : next.leadingToken.length
    : 0
  return prev.contentEnd + hyphenWrapSlack >= Math.max(35, terminalCols - 8)
}

function canRowContinueWrappedPath(
  prev: WrappedRowSlice,
  next: WrappedRowSlice,
  terminalCols?: number
): boolean {
  if (
    !hasReachedWrapWidth(prev, next, terminalCols) ||
    !canRowStartWrappedPath(prev) ||
    !next.leadingToken ||
    (next.leadingToken === '-' &&
      (next.content.length === 1 || /\s/.test(next.content.charAt(1)))) ||
    /^(?:~[\\/]|\/{2}|\\\\|\.{1,2}[\\/]|[A-Za-z]:[\\/])/.test(next.leadingToken)
  ) {
    return false
  }
  if (
    /\.[A-Za-z0-9_+-]+(?::\d+)*$/.test(prev.trailingToken) &&
    !/[\\/]\.[A-Za-z0-9_+-]+$/.test(prev.trailingToken)
  ) {
    if (
      /^(?::\d+(?:-\d+)?(?::\d+)?|#(?:L|line-?)\d+)/i.test(next.leadingToken) ||
      (/:\d+$/.test(prev.trailingToken) && /^\d+(?:-\d+)?(?::\d+)?$/.test(next.leadingToken))
    ) {
      return true
    }
    return (
      /\.[a-z0-9]{1,2}$/.test(prev.trailingToken) &&
      /^[a-z0-9]{1,4}(?::\d+)*$/.test(next.leadingToken)
    )
  }
  if (
    !/[\\/.:#]/.test(next.leadingToken) &&
    !/[\\/\-.:]$/.test(prev.trailingToken) &&
    /^[A-Z][a-z]+$/.test(next.leadingToken)
  ) {
    return false
  }
  return true
}

export function matchWrappedFilePathAtRowColumn(
  rows: readonly TerminalWrappedLineRow[],
  tappedRowIndex: number,
  tappedCol: number,
  terminalCols?: number
): TappedFilePath | null {
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
      const rowText = rows[i]?.text ?? ''
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
      canRowContinueWrappedPath(slices[hardStart - 1]!, slices[hardStart]!, terminalCols) &&
      (hardStart === tappedRowIndex
        ? tappedCol < slices[hardStart]!.contentStart + slices[hardStart]!.leadingToken.length &&
          (isFullRowPathToken(slices[hardStart]!) || /[\\/.:#]/.test(slices[hardStart]!.leadingToken))
        : isFullRowPathToken(slices[hardStart]!))
    ) {
      hardStart -= 1
      if (!isFullRowPathToken(slices[hardStart]!)) {
        break
      }
    }
    let hardEnd = tappedRowIndex
    while (
      hardEnd + 1 < slices.length &&
      canRowContinueWrappedPath(slices[hardEnd]!, slices[hardEnd + 1]!, terminalCols) &&
      (hardEnd === hardStart
        ? tappedCol >= slices[hardEnd]!.contentEnd - slices[hardEnd]!.trailingToken.length
        : isFullRowPathToken(slices[hardEnd]!)) &&
      (isFullRowPathToken(slices[hardEnd + 1]!) ||
        /[\\/.:#]/.test(slices[hardEnd + 1]!.leadingToken))
    ) {
      hardEnd += 1
      if (!isFullRowPathToken(slices[hardEnd]!)) {
        break
      }
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

// Returns the file-path span (after punctuation trim) that contains `col`, or
// null when the tap isn't on a path.
export function matchFilePathAtColumn(lineText: string, col: number): TappedFilePath | null {
  const spaced = matchSpacedFilePathAtColumn(lineText, col)
  if (spaced) {
    return spaced
  }
  LOCAL_PATH_REGEX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = LOCAL_PATH_REGEX.exec(lineText)) !== null) {
    if (match[0].length === 0) {
      LOCAL_PATH_REGEX.lastIndex += 1
      continue
    }
    const trimmed = trimBoundaryPunctuation(match[0], match.index)
    if (!trimmed) {
      continue
    }
    if (col < trimmed.startIndex || col >= trimmed.endIndex) {
      continue
    }
    const parsed = parsePathWithOptionalLineColumn(trimmed.text)
    if (parsed) {
      return parsed
    }
  }
  return null
}
