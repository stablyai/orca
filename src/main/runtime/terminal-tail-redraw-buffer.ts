import {
  hasCanonicalNumericCsiParams,
  parseAnsiControlSequence
} from './terminal-ansi-normalization'
import { clampTerminalPreviewCursor, trimTerminalLineRight } from './terminal-tail-line-controls'
import { MAX_TAIL_CHARS, MAX_TAIL_LINES, MAX_TAIL_PARTIAL_CHARS } from './terminal-tail-limits'

export function appendNormalizedToMultilineTailBufferUnwindowed(
  previousLines: string[],
  boundedPreviousPartialLine: string,
  normalizedChunk: string,
  previousPartialWasCapped: boolean,
  previousRedrawCursor: RetainedTailRedrawCursor | null
): {
  lines: string[]
  partialLine: string
  redrawCursor: RetainedTailRedrawCursor | null
  truncated: boolean
  newCompleteLines: number
  newlyCompletedLines: string[]
} {
  const rows: RetainedTerminalRow[] = [
    ...previousLines.map((line) => ({ text: line, completed: true })),
    { text: boundedPreviousPartialLine, completed: false }
  ]
  let cursorRow = previousRedrawCursor
    ? Math.max(0, rows.length - 1 - previousRedrawCursor.rowFromEnd)
    : rows.length - 1
  let cursorColumn = previousRedrawCursor?.column ?? boundedPreviousPartialLine.length
  let newCompleteLines = 0
  const newlyCompletedLines: string[] = []
  let newlyCompletedLineCharacters = 0
  let newlyCompletedLineStart = 0
  let truncated = previousPartialWasCapped

  const retainNewlyCompletedLine = (line: string): void => {
    newlyCompletedLines.push(line)
    newlyCompletedLineCharacters += line.length
    while (
      newlyCompletedLines.length - newlyCompletedLineStart > MAX_TAIL_LINES ||
      newlyCompletedLineCharacters > MAX_TAIL_CHARS
    ) {
      newlyCompletedLineCharacters -= newlyCompletedLines[newlyCompletedLineStart]!.length
      newlyCompletedLineStart += 1
    }
    // Why: a single PTY chunk can carry unbounded newlines; compact in batches while retaining the suffix needed for stable pagination.
    if (newlyCompletedLineStart >= MAX_TAIL_LINES) {
      newlyCompletedLines.splice(0, newlyCompletedLineStart)
      newlyCompletedLineStart = 0
    }
  }

  const ensureCursorRow = (): void => {
    while (cursorRow >= rows.length) {
      rows.push({ text: '', completed: false })
    }
  }
  const trimRows = (): void => {
    const maxRows = MAX_TAIL_LINES + 1
    if (rows.length <= maxRows) {
      return
    }
    const removeCount = rows.length - maxRows
    rows.splice(0, removeCount)
    cursorRow = Math.max(0, cursorRow - removeCount)
    truncated = true
  }
  const moveCursorToColumn = (nextColumn: number): void => {
    cursorColumn = clampTerminalPreviewCursor(nextColumn)
  }
  const markCursorRowRewritten = (): void => {
    ensureCursorRow()
    rows[cursorRow]!.completed = false
  }
  const writeChar = (char: string): void => {
    ensureCursorRow()
    markCursorRowRewritten()
    const row = rows[cursorRow]!
    if (cursorColumn > row.text.length) {
      row.text = `${row.text}${' '.repeat(cursorColumn - row.text.length)}`
    }
    row.text =
      cursorColumn >= row.text.length
        ? `${row.text}${char}`
        : `${row.text.slice(0, cursorColumn)}${char}${row.text.slice(cursorColumn + 1)}`
    cursorColumn += 1
  }
  const eraseLine = (mode: number): void => {
    ensureCursorRow()
    markCursorRowRewritten()
    const row = rows[cursorRow]!
    if (mode === 0) {
      row.text = row.text.slice(0, cursorColumn)
    } else if (mode === 1) {
      const deleteCount = Math.min(cursorColumn + 1, row.text.length)
      row.text = `${' '.repeat(deleteCount)}${row.text.slice(deleteCount)}`
    } else if (mode === 2) {
      row.text = ''
    }
  }

  for (let index = 0; index < normalizedChunk.length; index += 1) {
    const char = normalizedChunk[index]
    if (char === '\n') {
      ensureCursorRow()
      rows[cursorRow]!.completed = true
      newCompleteLines += 1
      retainNewlyCompletedLine(trimTerminalLineRight(rows[cursorRow]!.text))
      cursorRow += 1
      cursorColumn = 0
      ensureCursorRow()
      trimRows()
      continue
    }
    if (char === '\r') {
      cursorColumn = 0
      continue
    }
    if (char === '\u0008') {
      cursorColumn = Math.max(0, cursorColumn - 1)
      continue
    }
    if (char === '\u001b') {
      const parsed = parseAnsiControlSequence(normalizedChunk, index)
      if (!parsed) {
        continue
      }
      index = parsed.endIndex
      if (parsed.kind !== 'csi' || !hasCanonicalNumericCsiParams(parsed.params)) {
        continue
      }
      const firstParam = parsed.firstParam ?? 1
      if (parsed.final === 'A') {
        cursorRow = Math.max(0, cursorRow - firstParam)
        rows.splice(cursorRow + 1)
      } else if (parsed.final === 'K') {
        eraseLine(parsed.firstParam ?? 0)
      } else if (parsed.final === 'G' || parsed.final === '`') {
        moveCursorToColumn(firstParam - 1)
      } else if (parsed.final === 'D') {
        cursorColumn = Math.max(0, cursorColumn - firstParam)
      } else if (parsed.final === 'C') {
        moveCursorToColumn(cursorColumn + firstParam)
      }
      continue
    }
    writeChar(char)
  }

  return finalizeRetainedTerminalRows(
    rows,
    cursorRow,
    cursorColumn,
    truncated,
    newCompleteLines,
    newlyCompletedLineStart > 0
      ? newlyCompletedLines.slice(newlyCompletedLineStart)
      : newlyCompletedLines
  )
}

export type RetainedTailRedrawCursor = {
  rowFromEnd: number
  column: number
}

type RetainedTerminalRow = {
  text: string
  completed: boolean
}

function finalizeRetainedTerminalRows(
  rows: RetainedTerminalRow[],
  cursorRow: number,
  cursorColumn: number,
  initialTruncated: boolean,
  newCompleteLines: number,
  newlyCompletedLines: string[]
): {
  lines: string[]
  partialLine: string
  redrawCursor: RetainedTailRedrawCursor | null
  truncated: boolean
  newCompleteLines: number
  newlyCompletedLines: string[]
} {
  let truncated = initialTruncated
  let retainedRows = rows.map((row) => ({ ...row, text: row.text.replace(/[ \t]+$/g, '') }))

  if (retainedRows.length > MAX_TAIL_LINES + 1) {
    const removeCount = retainedRows.length - (MAX_TAIL_LINES + 1)
    retainedRows = retainedRows.slice(removeCount)
    cursorRow = Math.max(0, cursorRow - removeCount)
    truncated = true
  }

  let totalChars = retainedRows.reduce((sum, row) => sum + row.text.length, 0)
  let trimStartIndex = 0
  while (trimStartIndex < retainedRows.length - 1 && totalChars > MAX_TAIL_CHARS) {
    totalChars -= retainedRows[trimStartIndex]!.text.length
    trimStartIndex += 1
  }
  if (trimStartIndex > 0) {
    retainedRows = retainedRows.slice(trimStartIndex)
    cursorRow = Math.max(0, cursorRow - trimStartIndex)
    truncated = true
  }
  while (
    retainedRows.length > 1 &&
    cursorRow < retainedRows.length - 1 &&
    retainedRows.at(-1)?.completed === false &&
    retainedRows.at(-1)?.text.length === 0
  ) {
    retainedRows.pop()
  }

  const lastRow = retainedRows.at(-1)
  let partialLine = lastRow && !lastRow.completed ? lastRow.text : ''
  let lines = (lastRow && !lastRow.completed ? retainedRows.slice(0, -1) : retainedRows).map(
    (row) => row.text
  )

  if (partialLine.length > MAX_TAIL_PARTIAL_CHARS) {
    partialLine = partialLine.slice(-MAX_TAIL_PARTIAL_CHARS)
    truncated = true
  }
  if (lines.length > MAX_TAIL_LINES) {
    lines = lines.slice(lines.length - MAX_TAIL_LINES)
    truncated = true
  }
  const outputRowCount = lines.length + 1
  const defaultCursorRow = outputRowCount - 1
  const defaultCursorColumn = partialLine.length
  const redrawCursor =
    cursorRow === defaultCursorRow && cursorColumn === defaultCursorColumn
      ? null
      : {
          rowFromEnd: Math.max(0, outputRowCount - 1 - cursorRow),
          column: clampTerminalPreviewCursor(cursorColumn)
        }

  return {
    lines,
    partialLine,
    redrawCursor,
    truncated,
    newCompleteLines,
    newlyCompletedLines
  }
}
