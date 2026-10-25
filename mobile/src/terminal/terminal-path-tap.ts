import {
  parseFileLinkLocation,
  type ParsedFileLinkLocation
} from '../../../src/shared/file-link-location'

export type TappedFilePath = ParsedFileLinkLocation

// Accept bare filenames as well as slash paths; host existence checks filter prose candidates.
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
  const parsed = parseFileLinkLocation(value)
  if (!parsed) {
    return null
  }
  const { pathText, line, column } = parsed
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
  // Extend spaced paths only over separator-bearing segments so trailing prose cannot be swallowed.
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
