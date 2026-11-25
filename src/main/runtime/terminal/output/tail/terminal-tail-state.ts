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
  // Resolve both caps against the virtual concatenation so the kept window is copied once.
  const keptPrevious = omittedNewLineCount > 0 ? 0 : previousLines.length
  const combinedLength = keptPrevious + newlyCompletedLines.length
  const lineAt = (index: number): string =>
    index < keptPrevious ? previousLines[index]! : newlyCompletedLines[index - keptPrevious]!
  let characters = omittedNewLineCount > 0 ? 0 : previousCharacters
  for (const line of newlyCompletedLines) {
    characters += line.length
  }

  let dropCount = Math.max(0, combinedLength - MAX_TAIL_LINES)
  for (let index = 0; index < dropCount; index += 1) {
    characters -= lineAt(index).length
  }
  while (dropCount < combinedLength && characters > MAX_TAIL_CHARS) {
    characters -= lineAt(dropCount).length
    dropCount += 1
  }

  const lines: string[] =
    dropCount < keptPrevious ? previousLines.slice(dropCount, keptPrevious) : []
  for (
    let index = Math.max(0, dropCount - keptPrevious);
    index < newlyCompletedLines.length;
    index += 1
  ) {
    lines.push(newlyCompletedLines[index]!)
  }

  return {
    lines,
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
