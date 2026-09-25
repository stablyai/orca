// Per-cell grid descriptors for the serialize round-trip oracle
// (serialize-grid-roundtrip.ts): visually effective state only, so a replay
// is compared on what a user would see, not on internal attribute encoding.
import type { Terminal } from '@xterm/headless'

export type GridDiff = { stage: string; row?: number; expected: unknown; actual: unknown }

type BufferLine = NonNullable<ReturnType<Terminal['buffer']['active']['getLine']>>
type Buffer = Terminal['buffer']['active']

const COLOR_MODE_P16 = 16777216
const COLOR_MODE_P256 = 33554432
const DEFAULT_BLANK = '▯·w1·b0:-1·000'
export const CLIPPED = 'CLIPPED'

// SerializeAddon re-emits palette 0-15 set via 38;5;N as SGR 30-37/90-97; same theme slot.
function canonicalColorMode(mode: number, colorValue: number): number {
  return mode === COLOR_MODE_P256 && colorValue >= 0 && colorValue < 16 ? COLOR_MODE_P16 : mode
}

function flags(values: boolean[]): string {
  return values.map((flag) => (flag ? '1' : '0')).join('')
}

/** Visually effective cell state, same blank-cell policy as terminal-restore-parity-fixture. */
export function cellDescriptor(line: BufferLine | undefined, x: number, cols: number): string {
  if (!line || x >= line.length) {
    return DEFAULT_BLANK
  }
  const cell = line.getCell(x)
  if (!cell) {
    return DEFAULT_BLANK
  }
  if (x === cols - 1 && line.length > cols && cell.getWidth() > 1) {
    return CLIPPED
  }
  const chars = cell.getChars()
  const fgMode = canonicalColorMode(cell.getFgColorMode(), cell.getFgColor())
  const bgMode = canonicalColorMode(cell.getBgColorMode(), cell.getBgColor())
  if (chars === '' || chars === ' ') {
    const blank = chars === ' '
    const inverseFg = cell.isInverse() ? `·if${fgMode}:${cell.getFgColor()}` : ''
    return `▯·w${cell.getWidth()}·b${bgMode}:${cell.getBgColor()}·${flags([
      blank && cell.isUnderline() !== 0,
      blank && cell.isStrikethrough() !== 0,
      blank && cell.isOverline() !== 0
    ])}${inverseFg}`
  }
  const cellFlags = flags([
    cell.isBold() !== 0,
    cell.isDim() !== 0,
    cell.isItalic() !== 0,
    cell.isUnderline() !== 0,
    cell.isInverse() !== 0,
    cell.isInvisible() !== 0,
    cell.isStrikethrough() !== 0
  ])
  return `${chars}·w${cell.getWidth()}·f${fgMode}:${cell.getFgColor()}·b${bgMode}:${cell.getBgColor()}·${cellFlags}`
}

function rowCells(line: BufferLine | undefined, cols: number): string[] {
  return Array.from({ length: cols }, (_, x) => cellDescriptor(line, x, cols))
}

// A wide glyph whose trailing half lies past the grid cannot be replayed; any blank is faithful.
function cellsMatch(expected: string, actual: string): boolean {
  return expected === actual || (expected === CLIPPED && actual.startsWith('▯'))
}

function rowsMatch(expected: string[], actual: string[]): boolean {
  return expected.length === actual.length && expected.every((e, i) => cellsMatch(e, actual[i]!))
}

export function bufferRows(buffer: Buffer, start: number, end: number, cols: number): string[][] {
  const rows: string[][] = []
  for (let y = start; y < end; y++) {
    rows.push(rowCells(buffer.getLine(y), cols))
  }
  while (rows.length > 0 && rows.at(-1)!.every((c) => c === DEFAULT_BLANK)) {
    rows.pop()
  }
  return rows
}

export function compareRowSets(
  stage: string,
  expected: string[][],
  actual: string[][]
): GridDiff | null {
  const length = Math.max(expected.length, actual.length)
  for (let y = 0; y < length; y++) {
    const e = expected[y]
    const a = actual[y]
    if (!e || !a || !rowsMatch(e, a)) {
      return { stage, row: y, expected: e?.join('|'), actual: a?.join('|') }
    }
  }
  return null
}
