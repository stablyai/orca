export type GitHubPrFileLineSource = {
  content: string
  lineCount: number
}

export type GitHubPrFileCommonLineEdges = {
  prefixLineCount: number
  suffixLineCount: number
}

type LineBounds = {
  start: number
  end: number
}

type ForwardLineCursor = {
  offset: number
  remaining: number
  source: GitHubPrFileLineSource
}

type ReverseLineCursor = {
  boundary: number
  remaining: number
  source: GitHubPrFileLineSource
}

export function createGitHubPrFileLineSource(content: string): GitHubPrFileLineSource {
  if (content.length === 0) {
    return { content, lineCount: 0 }
  }
  let lineCount = content.endsWith('\n') ? 0 : 1
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) {
      lineCount += 1
    }
  }
  return { content, lineCount }
}

export function findGitHubPrFileCommonLineEdges(
  original: GitHubPrFileLineSource,
  modified: GitHubPrFileLineSource
): GitHubPrFileCommonLineEdges {
  const comparableLineCount = Math.min(original.lineCount, modified.lineCount)
  const originalForward = createForwardCursor(original)
  const modifiedForward = createForwardCursor(modified)
  let prefixLineCount = 0
  while (prefixLineCount < comparableLineCount) {
    const originalLine = takeNextLine(originalForward)!
    const modifiedLine = takeNextLine(modifiedForward)!
    if (!lineBoundsEqual(original, originalLine, modified, modifiedLine)) {
      break
    }
    prefixLineCount += 1
  }

  const originalReverse = createReverseCursor(original)
  const modifiedReverse = createReverseCursor(modified)
  const maxSuffixLineCount = comparableLineCount - prefixLineCount
  let suffixLineCount = 0
  while (suffixLineCount < maxSuffixLineCount) {
    const originalLine = takePreviousLine(originalReverse)!
    const modifiedLine = takePreviousLine(modifiedReverse)!
    if (!lineBoundsEqual(original, originalLine, modified, modifiedLine)) {
      break
    }
    suffixLineCount += 1
  }
  return { prefixLineCount, suffixLineCount }
}

export function visitGitHubPrFileLineRange(
  source: GitHubPrFileLineSource,
  startLine: number,
  lineCount: number,
  visit: (line: string) => void
): void {
  if (lineCount <= 0) {
    return
  }
  const cursor = createForwardCursor(source)
  for (let index = 0; index < startLine; index += 1) {
    takeNextLine(cursor)
  }
  for (let index = 0; index < lineCount; index += 1) {
    const bounds = takeNextLine(cursor)
    if (!bounds) {
      return
    }
    visit(source.content.slice(bounds.start, bounds.end))
  }
}

export function collectGitHubPrFileLineRange(
  source: GitHubPrFileLineSource,
  startLine: number,
  lineCount: number
): string[] {
  const lines: string[] = []
  visitGitHubPrFileLineRange(source, startLine, lineCount, (line) => lines.push(line))
  return lines
}

function createForwardCursor(source: GitHubPrFileLineSource): ForwardLineCursor {
  return { source, offset: 0, remaining: source.lineCount }
}

function takeNextLine(cursor: ForwardLineCursor): LineBounds | null {
  if (cursor.remaining === 0) {
    return null
  }
  const { content } = cursor.source
  const separator = content.indexOf('\n', cursor.offset)
  const rawEnd = separator === -1 ? content.length : separator
  const end =
    separator !== -1 && rawEnd > cursor.offset && content.charCodeAt(rawEnd - 1) === 13
      ? rawEnd - 1
      : rawEnd
  const bounds = { start: cursor.offset, end }
  cursor.offset = separator === -1 ? content.length : separator + 1
  cursor.remaining -= 1
  return bounds
}

function createReverseCursor(source: GitHubPrFileLineSource): ReverseLineCursor {
  return {
    source,
    boundary: source.content.endsWith('\n') ? source.content.length - 1 : source.content.length,
    remaining: source.lineCount
  }
}

function takePreviousLine(cursor: ReverseLineCursor): LineBounds | null {
  if (cursor.remaining === 0) {
    return null
  }
  const { content } = cursor.source
  const separator = cursor.boundary === 0 ? -1 : content.lastIndexOf('\n', cursor.boundary - 1)
  const start = separator + 1
  const end =
    cursor.boundary < content.length &&
    cursor.boundary > start &&
    content.charCodeAt(cursor.boundary - 1) === 13
      ? cursor.boundary - 1
      : cursor.boundary
  cursor.boundary = separator === -1 ? 0 : separator
  cursor.remaining -= 1
  return { start, end }
}

function lineBoundsEqual(
  leftSource: GitHubPrFileLineSource,
  left: LineBounds,
  rightSource: GitHubPrFileLineSource,
  right: LineBounds
): boolean {
  const length = left.end - left.start
  if (length !== right.end - right.start) {
    return false
  }
  for (let offset = 0; offset < length; offset += 1) {
    if (
      leftSource.content.charCodeAt(left.start + offset) !==
      rightSource.content.charCodeAt(right.start + offset)
    ) {
      return false
    }
  }
  return true
}
