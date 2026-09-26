import {
  MAX_PREVIEW_CHARS,
  MAX_PREVIEW_LINES,
  MAX_TAIL_CHARS,
  MAX_TAIL_LINES
} from './terminal-tail-limits'
import type { RetainedTailRedrawCursor } from './terminal-tail-redraw-buffer'

export function buildPreview(lines: string[], partialLine: string): string {
  const previewLines: string[] = []
  const collectVisibleLine = (line: string): void => {
    const trimmed = line.trim()
    if (trimmed.length > 0) {
      previewLines.push(trimmed)
    }
  }

  if (partialLine.length > 0) {
    collectVisibleLine(partialLine)
  }
  for (
    let index = lines.length - 1;
    index >= 0 && previewLines.length < MAX_PREVIEW_LINES;
    index--
  ) {
    collectVisibleLine(lines[index])
  }
  previewLines.reverse()

  const preview = previewLines.join('\n')
  return preview.length > MAX_PREVIEW_CHARS
    ? preview.slice(preview.length - MAX_PREVIEW_CHARS)
    : preview
}

export function appendCompletedTerminalTranscript(
  previousLines: string[],
  previousCharacters: number,
  newlyCompletedLines: string[],
  newCompleteLineCount: number
): { lines: string[]; characters: number; truncated: boolean } {
  if (newCompleteLineCount === 0) {
    return { lines: previousLines, characters: previousCharacters, truncated: false }
  }

  const omittedNewLineCount = Math.max(0, newCompleteLineCount - newlyCompletedLines.length)
  const lines = omittedNewLineCount > 0 ? [] : [...previousLines]
  let characters = omittedNewLineCount > 0 ? 0 : previousCharacters
  for (const line of newlyCompletedLines) {
    lines.push(line)
    characters += line.length
  }

  let dropCount = Math.max(0, lines.length - MAX_TAIL_LINES)
  for (let index = 0; index < dropCount; index += 1) {
    characters -= lines[index]!.length
  }
  while (dropCount < lines.length && characters > MAX_TAIL_CHARS) {
    characters -= lines[dropCount]!.length
    dropCount += 1
  }

  return {
    lines: dropCount > 0 ? lines.slice(dropCount) : lines,
    characters,
    truncated: omittedNewLineCount > 0 || dropCount > 0
  }
}

export function tailStateMatches(
  lines: string[],
  transcriptLines: string[],
  partialLine: string,
  pendingAnsi: string,
  redrawCursor: RetainedTailRedrawCursor | null,
  truncated: boolean,
  linesTotal: number,
  snapshot: {
    lines: string[]
    transcriptLines: string[]
    partialLine: string
    pendingAnsi: string
    redrawCursor: RetainedTailRedrawCursor | null
    truncated: boolean
    linesTotal: number
  }
): boolean {
  if (
    partialLine !== snapshot.partialLine ||
    pendingAnsi !== snapshot.pendingAnsi ||
    !tailRedrawCursorsMatch(redrawCursor, snapshot.redrawCursor) ||
    truncated !== snapshot.truncated ||
    linesTotal !== snapshot.linesTotal ||
    lines.length !== snapshot.lines.length ||
    transcriptLines.length !== snapshot.transcriptLines.length
  ) {
    return false
  }
  if (lines === snapshot.lines) {
    return true
  }
  for (let index = 0; index < lines.length; index++) {
    if (lines[index] !== snapshot.lines[index]) {
      return false
    }
  }
  if (transcriptLines !== snapshot.transcriptLines) {
    for (let index = 0; index < transcriptLines.length; index++) {
      if (transcriptLines[index] !== snapshot.transcriptLines[index]) {
        return false
      }
    }
  }
  return true
}

function tailRedrawCursorsMatch(
  left: RetainedTailRedrawCursor | null,
  right: RetainedTailRedrawCursor | null
): boolean {
  if (left === right) {
    return true
  }
  if (!left || !right) {
    return false
  }
  return left.rowFromEnd === right.rowFromEnd && left.column === right.column
}

export function buildTailLines(lines: string[], partialLine: string): string[] {
  return partialLine.length > 0 ? [...lines, partialLine] : lines
}
