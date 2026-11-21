import type { Terminal } from '@xterm/headless'
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
  for (let row = start; row < end; row += 1) {
    const line = buffer.getLine(row)
    const cols = Math.min(line?.length ?? 0, terminal.cols)
    // Match snapshot serialization when a shrink leaves half of a wide glyph outside the grid.
    const clippedWideCell =
      line && line.length > cols && (line.getCell(cols - 1)?.getWidth() ?? 0) > 1
    const textCols = clippedWideCell ? cols - 1 : cols
    const text = line?.translateToString(true, 0, textCols) ?? ''
    rows.push({
      text,
      metadata: {
        wrapped: line?.isWrapped ?? false,
        trailingSpaces: buffer.getLine(row + 1)?.isWrapped
          ? (line?.translateToString(false, 0, textCols).length ?? 0) +
            (clippedWideCell ? 1 : 0) -
            text.length
          : 0
      }
    })
  }
  return rows
}
