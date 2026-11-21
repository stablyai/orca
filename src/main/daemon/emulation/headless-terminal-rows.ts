import type { Terminal } from '@xterm/headless'
import {
  getClippedTerminalLineColumns,
  translateClippedTerminalLine
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

export function readHeadlessTerminalLines(terminal: Terminal, limit?: number): string[] {
  const { buffer, start, end } = terminalRowRange(terminal, limit)
  const lines: string[] = []
  for (let row = start; row < end; row += 1) {
    lines.push(buffer.getLine(row)?.translateToString(true) ?? '')
  }
  return lines
}

export function readHeadlessTerminalRows(
  terminal: Terminal,
  limit?: number
): HeadlessTerminalRow[] {
  const { buffer, start, end } = terminalRowRange(terminal, limit)
  const rows: HeadlessTerminalRow[] = []
  let reusableCell: ReturnType<typeof buffer.getNullCell> | undefined
  for (let row = start; row < end; row += 1) {
    const line = buffer.getLine(row)
    const clipped =
      limit === undefined && line && line.length > terminal.cols
        ? getClippedTerminalLineColumns(
            line,
            terminal.cols,
            (reusableCell ??= buffer.getNullCell())
          )
        : undefined
    const text =
      line && clipped
        ? translateClippedTerminalLine(line, clipped, true, reusableCell)
        : (line?.translateToString(true) ?? '')
    const trailingSpaces = buffer.getLine(row + 1)?.isWrapped
      ? (line && clipped
          ? translateClippedTerminalLine(line, clipped, false, reusableCell).length
          : (line?.translateToString(false).length ?? text.length)) - text.length
      : 0
    rows.push({
      text,
      metadata: {
        wrapped: line?.isWrapped ?? false,
        trailingSpaces
      }
    })
  }
  return rows
}
