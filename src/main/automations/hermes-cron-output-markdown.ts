export const HERMES_OUTPUT_FILE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.md$/
const HERMES_RUN_KEY_PATTERN = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/
export const MAX_SESSION_OUTPUT_GAP_MS = 24 * 60 * 60 * 1000
export const MAX_REFERENCED_LOG_BYTES = 5 * 1024 * 1024
export const FULL_SESSION_LOG_HEADING = '## Full session log'
export const REFERENCED_LOG_HEADING = '## Latest log file'
const RUN_PREVIEW_LIMIT = 180
export const LATEST_LOG_PATH_PATTERN =
  /\bLatest log path:\s*(?<path>(?:[A-Za-z]:[\\/]|\/)[^\r\n]*?)(?=\s+Run summary:|\r?\n|$)/i
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function runAtFromHermesOutputFile(filename: string): string | null {
  const match = HERMES_OUTPUT_FILE_PATTERN.exec(filename)
  if (!match) {
    return null
  }
  const [, year, month, day, hour, minute, second] = match
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`
}

export function runKeyFromHermesOutputFile(filename: string): string | null {
  const match = HERMES_OUTPUT_FILE_PATTERN.exec(filename)
  if (!match) {
    return null
  }
  const [, year, month, day, hour, minute, second] = match
  return `${year}${month}${day}_${hour}${minute}${second}`
}

export function runAtFromUnixSeconds(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  const date = new Date(value * 1000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function sortableTimeFromRunKey(runKey: string | null): number {
  if (!runKey) {
    return Number.NaN
  }
  const match = HERMES_RUN_KEY_PATTERN.exec(runKey)
  if (!match) {
    return Number.NaN
  }
  const [, year, month, day, hour, minute, second] = match
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  )
}

export function escapeSqlLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

type ContentRange = {
  start: number
  end: number
}

function cleanRunPreview(value: string, startIndex = 0, endIndex = value.length): string | null {
  const normalized = foldRunPreviewText(value, startIndex, endIndex)
  if (!normalized.text) {
    return null
  }
  return normalized.truncated
    ? `${normalized.text.slice(0, RUN_PREVIEW_LIMIT - 3)}...`
    : normalized.text
}

function foldRunPreviewText(
  value: string,
  startIndex: number,
  endIndex: number
): { text: string; truncated: boolean } {
  let text = ''
  let pendingSpace = false
  let index = Math.max(0, startIndex)
  const end = Math.min(value.length, endIndex)
  while (index < end && text.length <= RUN_PREVIEW_LIMIT) {
    if (startsWithAt(value, '```', index)) {
      if (text.length > 0) {
        pendingSpace = true
      }
      index = skipFencedBlock(value, index, end)
      continue
    }

    const code = value.charCodeAt(index)
    if (isPreviewSeparator(code)) {
      if (text.length > 0) {
        pendingSpace = true
      }
      index += 1
      continue
    }

    if (pendingSpace) {
      text += ' '
      pendingSpace = false
      if (text.length > RUN_PREVIEW_LIMIT) {
        break
      }
    }
    text += value[index]
    index += 1
  }
  return { text, truncated: text.length > RUN_PREVIEW_LIMIT }
}

function isPreviewSeparator(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 35 ||
    code === 40 ||
    code === 41 ||
    code === 42 ||
    code === 62 ||
    code === 91 ||
    code === 93 ||
    code === 95 ||
    code === 96
  )
}

export function parseHermesOutput(content: string): {
  status: 'completed' | 'failed' | 'unknown'
  outputPreview: string | null
  outputContent: string
  error: string | null
} {
  const errorHeading = findMarkdownHeading(content, '## Error')
  const responseHeading = findMarkdownHeading(content, '## Response')
  const errorRange = errorHeading ? errorContentRange(content, errorHeading.bodyStart) : null
  const failed = hasFailedCronHeading(content) || errorHeading !== null
  const error = errorRange ? cleanRunPreview(content, errorRange.start, errorRange.end) : null
  const previewRange = responseHeading
    ? { start: responseHeading.bodyStart, end: content.length }
    : (errorRange ?? { start: 0, end: content.length })
  return {
    status: failed ? 'failed' : responseHeading ? 'completed' : 'unknown',
    outputPreview: cleanRunPreview(content, previewRange.start, previewRange.end),
    outputContent: content,
    error
  }
}

function hasFailedCronHeading(content: string): boolean {
  let lineStart = 0
  while (lineStart < content.length) {
    const lineEnd = lineEndIndex(content, lineStart)
    if (
      startsWithAt(content, '#', lineStart) &&
      lineContains(content, lineStart, lineEnd, 'Cron Job:') &&
      lineContains(content, lineStart, lineEnd, '(FAILED)')
    ) {
      return true
    }
    lineStart = nextLineStart(content, lineEnd)
  }
  return false
}

function findMarkdownHeading(
  content: string,
  heading: '## Error' | '## Response'
): { bodyStart: number } | null {
  let lineStart = 0
  while (lineStart < content.length) {
    const lineEnd = lineEndIndex(content, lineStart)
    if (
      startsWithAt(content, heading, lineStart) &&
      isHeadingBoundary(content.charCodeAt(lineStart + heading.length))
    ) {
      return { bodyStart: nextLineStart(content, lineEnd) }
    }
    lineStart = nextLineStart(content, lineEnd)
  }
  return null
}

function errorContentRange(content: string, bodyStart: number): ContentRange {
  const start = skipPreviewWhitespace(content, bodyStart, content.length)
  if (!startsWithAt(content, '```', start)) {
    return { start, end: nextMarkdownHeadingStart(content, start) ?? content.length }
  }

  const fencedStart = nextLineStart(content, lineEndIndex(content, start))
  const fencedEnd = findClosingFence(content, fencedStart) ?? content.length
  return { start: fencedStart, end: fencedEnd }
}

function skipFencedBlock(content: string, fenceStart: number, endIndex: number): number {
  const bodyStart = nextLineStart(content, lineEndIndex(content, fenceStart))
  const closeStart = findClosingFence(content, bodyStart)
  if (closeStart === null || closeStart > endIndex) {
    return endIndex
  }
  return nextLineStart(content, lineEndIndex(content, closeStart))
}

function findClosingFence(content: string, fromIndex: number): number | null {
  let lineStart = fromIndex
  while (lineStart < content.length) {
    const lineEnd = lineEndIndex(content, lineStart)
    const textStart = skipPreviewWhitespace(content, lineStart, lineEnd)
    if (startsWithAt(content, '```', textStart)) {
      return textStart
    }
    lineStart = nextLineStart(content, lineEnd)
  }
  return null
}

function nextMarkdownHeadingStart(content: string, fromIndex: number): number | null {
  let lineStart = fromIndex
  while (lineStart < content.length) {
    const lineEnd = lineEndIndex(content, lineStart)
    if (startsWithAt(content, '## ', lineStart)) {
      return lineStart
    }
    lineStart = nextLineStart(content, lineEnd)
  }
  return null
}

function lineEndIndex(value: string, startIndex: number): number {
  const newline = value.indexOf('\n', startIndex)
  return newline === -1 ? value.length : newline
}

function nextLineStart(value: string, lineEnd: number): number {
  return lineEnd < value.length ? lineEnd + 1 : value.length
}

function lineContains(
  value: string,
  startIndex: number,
  endIndex: number,
  needle: string
): boolean {
  const index = value.indexOf(needle, startIndex)
  return index !== -1 && index < endIndex
}

function skipPreviewWhitespace(value: string, startIndex: number, endIndex: number): number {
  let index = startIndex
  while (index < endIndex && isPreviewWhitespace(value.charCodeAt(index))) {
    index += 1
  }
  return index
}

function isPreviewWhitespace(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13)
}

function isHeadingBoundary(code: number): boolean {
  return Number.isNaN(code) || isPreviewWhitespace(code)
}

function startsWithAt(value: string, search: string, startIndex: number): boolean {
  if (startIndex + search.length > value.length) {
    return false
  }
  for (let offset = 0; offset < search.length; offset += 1) {
    if (value.charCodeAt(startIndex + offset) !== search.charCodeAt(offset)) {
      return false
    }
  }
  return true
}
