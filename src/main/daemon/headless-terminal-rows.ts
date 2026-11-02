import type { Terminal } from '@xterm/headless'
import type { RuntimeTerminalRowMetadata } from '../../shared/runtime-terminal-contracts'

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

/** Ctrl+L is safe at an empty PSReadLine prompt; PowerShell’s continuation prompt (>>) is excluded. */
export function isCursorOnEmptyPromptLine(terminal: Terminal): boolean {
  const buffer = terminal.buffer.active
  const line = buffer.getLine(buffer.baseY + buffer.cursorY)
  if (!line) {
    return false
  }
  const upToCursor = line.translateToString(true, 0, buffer.cursorX).trimEnd()
  const fullLine = line.translateToString(true).trimEnd()
  return fullLine === upToCursor && upToCursor.endsWith('>') && !upToCursor.endsWith('>>')
}

/**
 * The cursor's row is one whole line of the normal screen: no program owns an alternate screen, and
 * no wrap runs into or out of the row, so a line inserted above it cannot split what is typed there.
 */
export function isCursorOnWholeNormalLine(terminal: Terminal): boolean {
  const buffer = terminal.buffer.active
  const row = buffer.baseY + buffer.cursorY
  return (
    buffer.type === 'normal' &&
    buffer.getLine(row)?.isWrapped === false &&
    buffer.getLine(row + 1)?.isWrapped !== true
  )
}
