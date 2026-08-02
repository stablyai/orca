// File-path detection for a single tap in the terminal. Mirrors the desktop
// link detection (src/renderer/src/lib/terminal-links.ts) but only finds the
// one path span containing the tapped column — mobile opens a tapped path, it
// does not render hover links over the whole line.

export type TappedFilePath = {
  pathText: string
  line: number | null
  column: number | null
}

// Separator-anchored path tokens (absolute, relative, ~/, drive-letter, UNC) OR
// a bare filename with an extension (README.md, index.ts), optionally suffixed
// with :line or :line:col. Like desktop, we propose candidates and let the host
// existence-check reject non-files — agents often print a bare filename, so
// requiring a slash would miss the common case.
const LOCAL_PATH_REGEX =
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/]|(?=[A-Za-z0-9._-]*\.[A-Za-z0-9]))[A-Za-z0-9._~\-/%+@\\()[\]]*(?::\d+)?(?::\d+)?/g
const SPACED_PATH_REGEX =
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/])[^()[\]{}'",;<>|`\r\n]+(?::\d+)?(?::\d+)?/g

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
  const match = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(value)
  if (!match) {
    return null
  }
  const pathText = match[1]
  // Reject a directory-only token (trailing separator) for either slash style.
  if (!pathText || pathText.endsWith('/') || pathText.endsWith('\\')) {
    return null
  }
  const line = match[2] ? Number.parseInt(match[2], 10) : null
  const column = match[3] ? Number.parseInt(match[3], 10) : null
  if ((line !== null && line < 1) || (column !== null && column < 1)) {
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
