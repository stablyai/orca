// Which serialized ranges each serialize variant covers, and what they hold, for the
// I1 scope in serialize-grid-roundtrip.ts: a range with an overlong line or a trailing
// background-only row is where the Orca patch changes bytes on purpose.
import type { Terminal } from '@xterm/headless'

type Buffer = Terminal['buffer']['active']

export function serializedNormalStart(terminal: Terminal, scrollback: number | undefined): number {
  const length = terminal.buffer.normal.length
  return scrollback === undefined ? 0 : length - Math.min(length, scrollback + terminal.rows)
}

function hasOverlongLine(buffer: Buffer, start: number, end: number, cols: number): boolean {
  for (let y = start; y < end; y++) {
    if ((buffer.getLine(y)?.length ?? 0) > cols) {
      return true
    }
  }
  return false
}

export function variantOverlong(
  source: Terminal,
  scrollback: number | undefined,
  rangeRow: number
): boolean[] {
  const { cols } = source
  const normal = source.buffer.normal
  const alt = source.buffer.active.type === 'alternate'
  const altOverlong =
    alt && hasOverlongLine(source.buffer.alternate, 0, source.buffer.alternate.length, cols)
  return [
    altOverlong ||
      hasOverlongLine(normal, serializedNormalStart(source, scrollback), normal.length, cols),
    altOverlong || hasOverlongLine(normal, 0, normal.length, cols),
    hasOverlongLine(normal, rangeRow, Math.min(rangeRow + 2, normal.length - 1) + 1, cols)
  ]
}

// The patch keeps such rows only when the serializer trims (no scrollback in the range)
// and the cursor is not wrap-pending; anywhere else its bytes must match the old build.
function hasTrailingBackgroundRow(
  buffer: Buffer,
  start: number,
  end: number,
  { cols, rows }: { cols: number; rows: number }
): boolean {
  if (buffer.length - start > rows || buffer.cursorX >= cols) {
    return false
  }
  // Text as the serializer counts it: width-0 cells (e.g. an orphan combining mark) never are.
  let lastTextRow = start - 1
  for (let y = start; y < end; y++) {
    const line = buffer.getLine(y)
    for (let x = 0; x < cols; x++) {
      const cell = line?.getCell(x)
      if (cell && cell.getWidth() > 0 && cell.getChars() !== '') {
        lastTextRow = y
        break
      }
    }
  }
  for (let y = lastTextRow + 1; y < end; y++) {
    const line = buffer.getLine(y)
    for (let x = 0; x < cols; x++) {
      if (line?.getCell(x)?.isBgDefault() === false) {
        return true
      }
    }
  }
  return false
}

export function variantTrailingBackgroundRows(
  source: Terminal,
  scrollback: number | undefined,
  rangeRow: number
): boolean[] {
  const normal = source.buffer.normal
  const altTrailing =
    source.buffer.active.type === 'alternate' &&
    hasTrailingBackgroundRow(source.buffer.alternate, 0, source.buffer.alternate.length, source)
  return [
    altTrailing ||
      hasTrailingBackgroundRow(
        normal,
        serializedNormalStart(source, scrollback),
        normal.length,
        source
      ),
    altTrailing || hasTrailingBackgroundRow(normal, 0, normal.length, source),
    hasTrailingBackgroundRow(
      normal,
      rangeRow,
      Math.min(rangeRow + 2, normal.length - 1) + 1,
      source
    )
  ]
}
