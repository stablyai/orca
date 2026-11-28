import type { IBufferCell, IBufferLine, Terminal } from '@xterm/headless'
import {
  getClippedTerminalLineColumns,
  translateClippedTerminalLine,
  type TerminalGridReadOptions
} from '../../../shared/terminal/viewport/terminal-line-applied-columns'
import type { RuntimeTerminalRowMetadata } from '../../../shared/terminal/runtime/runtime-terminal-contracts'

export type HeadlessTerminalRow = { text: string; metadata: RuntimeTerminalRowMetadata }

function terminalRowRange(terminal: Terminal, limit?: number) {
  const buffer = terminal.buffer.active
  return {
    buffer,
    start:
      limit === undefined
        ? buffer.viewportY
        : Math.max(0, buffer.length - Math.max(0, Math.floor(limit))),
    end: limit === undefined ? buffer.viewportY + terminal.rows : buffer.length
  }
}

export function readHeadlessTerminalVisibleRange(terminal: Terminal) {
  const buffer = terminal.buffer.active
  const start = buffer.viewportY
  return {
    start,
    endExclusive: Math.min(buffer.length, start + terminal.rows),
    totalLength: buffer.length
  }
}

export function readHeadlessTerminalLines(terminal: Terminal, limit?: number): string[] {
  const { buffer, start, end } = terminalRowRange(terminal, limit)
  const lines: string[] = []
  for (let row = start; row < end; row += 1) {
    lines.push(buffer.getLine(row)?.translateToString(true) ?? '')
  }
  return lines
}

/** Reads the viewport up from its bottom row, stopping once `maxNonBlank` rows hold text or after `maxRows` rows. */
export function readHeadlessTerminalBottomLines(
  terminal: Terminal,
  maxNonBlank: number,
  maxRows: number
): string[] {
  const { buffer, start, end } = terminalRowRange(terminal)
  const translateGridLine = createGridLineTranslator(terminal)
  const lowest = Math.max(start, end - maxRows)
  const lines: string[] = []
  let nonBlank = 0
  for (let row = end - 1; row >= lowest && nonBlank < maxNonBlank; row -= 1) {
    const text = translateGridLine(buffer.getLine(row), true)
    nonBlank += text.trim().length > 0 ? 1 : 0
    lines.push(text)
  }
  return lines.toReversed()
}

export function readHeadlessTerminalRows(
  terminal: Terminal,
  limit?: number,
  options?: TerminalGridReadOptions
): HeadlessTerminalRow[] {
  if (options?.clipToGrid && limit === undefined) {
    return readHeadlessTerminalGridRows(terminal)
  }
  const { buffer, start, end } = terminalRowRange(terminal, limit)
  const rows: HeadlessTerminalRow[] = []
  for (let row = start; row < end; row += 1) {
    const line = buffer.getLine(row)
    const text = line?.translateToString(true) ?? ''
    rows.push({
      text,
      metadata: {
        wrapped: line?.isWrapped ?? false,
        trailingSpaces: buffer.getLine(row + 1)?.isWrapped
          ? (line?.translateToString(false).length ?? text.length) - text.length
          : 0
      }
    })
  }
  return rows
}

/** After a shrink, cells past `cols` stay in a line until a repaint clears them, so cut rows at the grid edge. */
function createGridLineTranslator(terminal: Terminal) {
  let reusableCell: IBufferCell | undefined
  return (line: IBufferLine | undefined, trimRight: boolean): string => {
    if (!line || line.length <= terminal.cols) {
      return line?.translateToString(trimRight) ?? ''
    }
    reusableCell ??= terminal.buffer.active.getNullCell()
    const clipped = getClippedTerminalLineColumns(line, terminal.cols, reusableCell)
    return clipped
      ? translateClippedTerminalLine(line, clipped, trimRight, reusableCell)
      : line.translateToString(trimRight)
  }
}

function readHeadlessTerminalGridRows(terminal: Terminal): HeadlessTerminalRow[] {
  const { buffer, start, end } = terminalRowRange(terminal)
  const translateGridLine = createGridLineTranslator(terminal)
  const rows: HeadlessTerminalRow[] = []
  for (let row = start; row < end; row += 1) {
    const line = buffer.getLine(row)
    const text = translateGridLine(line, true)
    rows.push({
      text,
      metadata: {
        wrapped: line?.isWrapped ?? false,
        trailingSpaces: buffer.getLine(row + 1)?.isWrapped
          ? translateGridLine(line, false).length - text.length
          : 0
      }
    })
  }
  return rows
}
