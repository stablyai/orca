import type { Terminal } from '@xterm/headless'
import type { RuntimeTerminalRowMetadata } from '../../../shared/runtime-terminal-contracts'
import {
  getTerminalLineOrigins,
  type TerminalOriginRuns
} from '../../../shared/terminal/output/terminal-content-origin'

export type HeadlessTerminalRow = {
  text: string
  metadata: RuntimeTerminalRowMetadata
  origins?: TerminalOriginRuns
}

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

export function isHeadlessCursorOnEmptyPrompt(terminal: Terminal): boolean {
  const buffer = terminal.buffer.active
  const line = buffer.getLine(buffer.baseY + buffer.cursorY)
  if (!line) {
    return false
  }
  const upToCursor = line.translateToString(true, 0, buffer.cursorX).trimEnd()
  const fullLine = line.translateToString(true).trimEnd()
  return fullLine === upToCursor && upToCursor.endsWith('>') && !upToCursor.endsWith('>>')
}

export function readHeadlessVisibleBufferRange(terminal: Terminal) {
  const buffer = terminal.buffer.active
  const start = buffer.viewportY
  return {
    start,
    endExclusive: Math.min(buffer.length, start + terminal.rows),
    totalLength: buffer.length
  }
}

const actionRows = new WeakMap<readonly string[], HeadlessTerminalRow[]>()
export function readHeadlessActionRows(
  emulator: { getVisibleRows(): HeadlessTerminalRow[] },
  lines: string[]
): HeadlessTerminalRow[] {
  const cached = actionRows.get(lines)
  if (cached) {
    return cached
  }
  const origins = getTerminalLineOrigins(lines)
  const rows = emulator.getVisibleRows().map((row, index) => ({
    ...row,
    origins: origins?.[index]
  }))
  actionRows.set(lines, rows)
  return rows
}
