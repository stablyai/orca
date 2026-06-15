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
// requiring a slash would miss the common case. The desktop's spaced-path
// variants are intentionally not ported: a tap always lands inside one
// whitespace-bounded segment, so this already covers the real cases.
const LOCAL_PATH_REGEX =
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/]|(?=[A-Za-z0-9._-]*\.[A-Za-z0-9]))[A-Za-z0-9._~\-/%+@\\()[\]]*(?::\d+)?(?::\d+)?/g

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

// Returns the file-path span (after punctuation trim) that contains `col`, or
// null when the tap isn't on a path.
export function matchFilePathAtColumn(lineText: string, col: number): TappedFilePath | null {
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
    // Inclusive of the trailing edge so a tap on the last glyph still counts.
    if (col < trimmed.startIndex || col > trimmed.endIndex) {
      continue
    }
    const parsed = parsePathWithOptionalLineColumn(trimmed.text)
    if (parsed) {
      return parsed
    }
  }
  return null
}
