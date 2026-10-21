// Per-cell grid descriptors for the serialize round-trip oracle
// (serialize-grid-roundtrip.ts): visually effective state only, so a replay
// is compared on what a user would see, not on internal attribute encoding.
import type { Terminal } from '@xterm/headless'

export type GridDiff = { stage: string; row?: number; expected: unknown; actual: unknown }

type BufferLine = NonNullable<ReturnType<Terminal['buffer']['active']['getLine']>>
type Buffer = Terminal['buffer']['active']
type Cell = ReturnType<Buffer['getNullCell']>

const COLOR_MODE_P16 = 16777216
const COLOR_MODE_P256 = 33554432
const DEFAULT_BLANK = '▯·w1·b0:-1·000'
export const CLIPPED = 'CLIPPED'

// SerializeAddon re-emits palette 0-15 set via 38;5;N as SGR 30-37/90-97; same theme slot.
function canonicalColorMode(mode: number, colorValue: number): number {
  return mode === COLOR_MODE_P256 && colorValue >= 0 && colorValue < 16 ? COLOR_MODE_P16 : mode
}

/** Visually effective cell state, same blank-cell policy as terminal-restore-parity-fixture. */
export function cellDescriptor(
  line: BufferLine | undefined,
  x: number,
  cols: number,
  reusableCell?: ReturnType<Buffer['getNullCell']>
): string {
  if (!line || x >= line.length) {
    return DEFAULT_BLANK
  }
  const cell = line.getCell(x, reusableCell)
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
    return `▯·w${cell.getWidth()}·b${bgMode}:${cell.getBgColor()}·${blank && cell.isUnderline() !== 0 ? '1' : '0'}${blank && cell.isStrikethrough() !== 0 ? '1' : '0'}${blank && cell.isOverline() !== 0 ? '1' : '0'}${inverseFg}`
  }
  const cellFlags =
    `${cell.isBold() !== 0 ? '1' : '0'}${cell.isDim() !== 0 ? '1' : '0'}` +
    `${cell.isItalic() !== 0 ? '1' : '0'}${cell.isUnderline() !== 0 ? '1' : '0'}` +
    `${cell.isInverse() !== 0 ? '1' : '0'}${cell.isInvisible() !== 0 ? '1' : '0'}` +
    `${cell.isStrikethrough() !== 0 ? '1' : '0'}`
  return `${chars}·w${cell.getWidth()}·f${fgMode}:${cell.getFgColor()}·b${bgMode}:${cell.getBgColor()}·${cellFlags}`
}

function rowCells(
  line: BufferLine | undefined,
  cols: number,
  reusableCell: ReturnType<Buffer['getNullCell']>
): string[] {
  return Array.from({ length: cols }, (_, x) => cellDescriptor(line, x, cols, reusableCell))
}

// A wide glyph whose trailing half lies past the grid cannot be replayed; any blank is faithful.
function cellsMatch(expected: string, actual: string): boolean {
  return expected === actual || (expected === CLIPPED && actual.startsWith('▯'))
}

function sameColor(
  expectedMode: number,
  expectedColor: number,
  actualMode: number,
  actualColor: number
): boolean {
  return (
    expectedColor === actualColor &&
    canonicalColorMode(expectedMode, expectedColor) === canonicalColorMode(actualMode, actualColor)
  )
}

// Equal public fields imply identical descriptors; differing fields still use the frozen policy.
function sameCellFields(expected: Cell, actual: Cell): boolean {
  if (
    expected.getWidth() !== actual.getWidth() ||
    !sameColor(
      expected.getBgColorMode(),
      expected.getBgColor(),
      actual.getBgColorMode(),
      actual.getBgColor()
    )
  ) {
    return false
  }
  const expectedChars = expected.getChars()
  const actualChars = actual.getChars()
  const expectedBlank = expectedChars === '' || expectedChars === ' '
  const actualBlank = actualChars === '' || actualChars === ' '
  if (expectedBlank || actualBlank) {
    return (
      expectedBlank &&
      actualBlank &&
      (expectedChars === ' ' && expected.isUnderline() !== 0) ===
        (actualChars === ' ' && actual.isUnderline() !== 0) &&
      (expectedChars === ' ' && expected.isStrikethrough() !== 0) ===
        (actualChars === ' ' && actual.isStrikethrough() !== 0) &&
      (expectedChars === ' ' && expected.isOverline() !== 0) ===
        (actualChars === ' ' && actual.isOverline() !== 0) &&
      (expected.isInverse() !== 0) === (actual.isInverse() !== 0) &&
      (expected.isInverse() === 0 ||
        sameColor(
          expected.getFgColorMode(),
          expected.getFgColor(),
          actual.getFgColorMode(),
          actual.getFgColor()
        ))
    )
  }
  return (
    expectedChars === actualChars &&
    sameColor(
      expected.getFgColorMode(),
      expected.getFgColor(),
      actual.getFgColorMode(),
      actual.getFgColor()
    ) &&
    (expected.isBold() !== 0) === (actual.isBold() !== 0) &&
    (expected.isDim() !== 0) === (actual.isDim() !== 0) &&
    (expected.isItalic() !== 0) === (actual.isItalic() !== 0) &&
    (expected.isUnderline() !== 0) === (actual.isUnderline() !== 0) &&
    (expected.isInverse() !== 0) === (actual.isInverse() !== 0) &&
    (expected.isInvisible() !== 0) === (actual.isInvisible() !== 0) &&
    (expected.isStrikethrough() !== 0) === (actual.isStrikethrough() !== 0)
  )
}

// Match the frozen default-blank descriptor without formatting every trailing cell.
function isDefaultBlank(line: BufferLine | undefined, x: number, scratch: Cell): boolean {
  if (!line || x >= line.length) {
    return true
  }
  const cell = line.getCell(x, scratch)
  if (!cell) {
    return true
  }
  const chars = cell.getChars()
  return (
    cell.getWidth() === 1 &&
    cell.getBgColorMode() === 0 &&
    cell.getBgColor() === -1 &&
    cell.isInverse() === 0 &&
    (chars === '' ||
      (chars === ' ' &&
        cell.isUnderline() === 0 &&
        cell.isStrikethrough() === 0 &&
        cell.isOverline() === 0))
  )
}

function trimmedEnd(
  buffer: Buffer,
  start: number,
  end: number,
  cols: number,
  scratch: Cell
): number {
  while (end > start) {
    const line = buffer.getLine(end - 1)
    let blank = true
    for (let x = 0; x < cols; x++) {
      if (!isDefaultBlank(line, x, scratch)) {
        blank = false
        break
      }
    }
    if (!blank) {
      break
    }
    end--
  }
  return end
}

function lineCellsMatch(
  expected: BufferLine | undefined,
  actual: BufferLine | undefined,
  cols: number,
  expectedScratch: Cell,
  actualScratch: Cell
): boolean {
  for (let x = 0; x < cols; x++) {
    const expectedCell =
      expected && x < expected.length ? expected.getCell(x, expectedScratch) : null
    const actualCell = actual && x < actual.length ? actual.getCell(x, actualScratch) : null
    const clipped =
      x === cols - 1 &&
      ((expected && expected.length > cols && (expectedCell?.getWidth() ?? 0) > 1) ||
        (actual && actual.length > cols && (actualCell?.getWidth() ?? 0) > 1))
    if (expectedCell && actualCell && !clipped && sameCellFields(expectedCell, actualCell)) {
      continue
    }
    if (
      !cellsMatch(
        cellDescriptor(expected, x, cols, expectedScratch),
        cellDescriptor(actual, x, cols, actualScratch)
      )
    ) {
      return false
    }
  }
  return true
}

/** Compares in place and formats only the first differing row, preserving diagnostic bytes. */
export function compareBufferRows(
  stage: string,
  expected: Buffer,
  expectedStart: number,
  expectedEnd: number,
  actual: Buffer,
  actualStart: number,
  actualEnd: number,
  cols: number
): GridDiff | null {
  const expectedScratch = expected.getNullCell()
  const actualScratch = actual.getNullCell()
  const expectedLength =
    trimmedEnd(expected, expectedStart, expectedEnd, cols, expectedScratch) - expectedStart
  const actualLength = trimmedEnd(actual, actualStart, actualEnd, cols, actualScratch) - actualStart
  for (let y = 0; y < Math.max(expectedLength, actualLength); y++) {
    const expectedLine = expected.getLine(expectedStart + y)
    const actualLine = actual.getLine(actualStart + y)
    if (
      y >= expectedLength ||
      y >= actualLength ||
      !lineCellsMatch(expectedLine, actualLine, cols, expectedScratch, actualScratch)
    ) {
      return {
        stage,
        row: y,
        expected:
          y < expectedLength ? rowCells(expectedLine, cols, expectedScratch).join('|') : undefined,
        actual: y < actualLength ? rowCells(actualLine, cols, actualScratch).join('|') : undefined
      }
    }
  }
  return null
}
