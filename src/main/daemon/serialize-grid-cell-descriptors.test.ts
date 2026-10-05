import { describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/headless'
import { cellDescriptor, compareBufferRows } from './serialize-grid-cell-descriptors'
import { createFuzzTerminal, writeTerminal } from './serialize-grid-roundtrip'

// Frozen allocating oracle from f69052e; a reused cell must preserve every descriptor.
type BufferLine = NonNullable<ReturnType<Terminal['buffer']['active']['getLine']>>
type Buffer = Terminal['buffer']['active']

const COLOR_MODE_P16 = 16777216
const COLOR_MODE_P256 = 33554432
const DEFAULT_BLANK = '▯·w1·b0:-1·000'
const CLIPPED = 'CLIPPED'

// SerializeAddon re-emits palette 0-15 set via 38;5;N as SGR 30-37/90-97; same theme slot.
function canonicalColorMode(mode: number, colorValue: number): number {
  return mode === COLOR_MODE_P256 && colorValue >= 0 && colorValue < 16 ? COLOR_MODE_P16 : mode
}

function flags(values: boolean[]): string {
  return values.map((flag) => (flag ? '1' : '0')).join('')
}

/** Visually effective cell state, same blank-cell policy as terminal-restore-parity-fixture. */
function allocatingCellDescriptor(line: BufferLine | undefined, x: number, cols: number): string {
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
  return Array.from({ length: cols }, (_, x) => allocatingCellDescriptor(line, x, cols))
}

function allocatingBufferRows(
  buffer: Buffer,
  start: number,
  end: number,
  cols: number
): string[][] {
  const rows: string[][] = []
  for (let y = start; y < end; y++) {
    rows.push(rowCells(buffer.getLine(y), cols))
  }
  while (rows.length > 0 && rows.at(-1)!.every((c) => c === DEFAULT_BLANK)) {
    rows.pop()
  }
  return rows
}

describe('serialize oracle cell reuse', () => {
  it('preserves the order of every text flag combination while reloading a plain cell', () => {
    const terminal = createFuzzTerminal({ cols: 4, rows: 1, scrollback: 0 })
    try {
      const sgr = [1, 2, 3, 4, 7, 8, 9]
      const scratch = terminal.buffer.active.getNullCell()
      for (let mask = 0; mask < 128; mask++) {
        const codes = sgr.filter((_code, bit) => (mask & (1 << bit)) !== 0)
        writeTerminal(terminal, `\x1b[H\x1b[0m\x1b[${codes.length ? codes.join(';') : 0}mA\x1b[0mB`)
        const line = terminal.buffer.active.getLine(0)
        expect(cellDescriptor(line, 0, 4, scratch)).toBe(allocatingCellDescriptor(line, 0, 4))
        expect(cellDescriptor(line, 1, 4, scratch)).toBe(allocatingCellDescriptor(line, 1, 4))
      }
    } finally {
      terminal.dispose()
    }
  })

  it('preserves styled spaces, empty cells and inverse foreground colors', () => {
    const terminal = createFuzzTerminal({ cols: 4, rows: 1, scrollback: 0 })
    try {
      const scratch = terminal.buffer.active.getNullCell()
      for (const inverse of [false, true]) {
        for (const glyph of ['', ' ']) {
          for (let mask = 0; mask < 8; mask++) {
            const codes = [4, 9, 53].filter((_code, bit) => (mask & (1 << bit)) !== 0)
            writeTerminal(
              terminal,
              `\x1b[H\x1b[0m\x1b[38;2;3;4;5;48;5;2${inverse ? ';7' : ''}${codes.length ? `;${codes.join(';')}` : ''}m\x1b[2J${glyph}`
            )
            const line = terminal.buffer.active.getLine(0)
            expect(cellDescriptor(line, 0, 4, scratch)).toBe(allocatingCellDescriptor(line, 0, 4))
          }
        }
      }
    } finally {
      terminal.dispose()
    }
  })

  it('preserves a clipped wide leading cell at the comparison grid edge', () => {
    const terminal = createFuzzTerminal({ cols: 8, rows: 1, scrollback: 0 })
    try {
      writeTerminal(terminal, 'abc界')
      const line = terminal.buffer.active.getLine(0)
      const scratch = terminal.buffer.active.getNullCell()
      expect(cellDescriptor(line, 3, 4, scratch)).toBe('CLIPPED')
      expect(cellDescriptor(line, 3, 4, scratch)).toBe(allocatingCellDescriptor(line, 3, 4))
    } finally {
      terminal.dispose()
    }
  })

  it('keeps missing lines and invalid columns blank after a styled cell occupied the scratch', () => {
    const terminal = createFuzzTerminal({ cols: 4, rows: 2, scrollback: 0 })
    try {
      writeTerminal(terminal, '\x1b[1;7;38;2;5;6;7mX')
      const line = terminal.buffer.active.getLine(0)
      const scratch = terminal.buffer.active.getNullCell()
      expect(cellDescriptor(line, 0, 4, scratch)).toBe(allocatingCellDescriptor(line, 0, 4))
      for (const x of [-1, 4, 5]) {
        expect(cellDescriptor(line, x, 4, scratch)).toBe(allocatingCellDescriptor(line, x, 4))
      }
      expect(cellDescriptor(undefined, 0, 4, scratch)).toBe(
        allocatingCellDescriptor(undefined, 0, 4)
      )
      expect(cellDescriptor(line, 1, 4, scratch)).toBe(allocatingCellDescriptor(line, 1, 4))
    } finally {
      terminal.dispose()
    }
  })
})

function allocatingRowDiff(stage: string, expected: string[][], actual: string[][]) {
  for (let y = 0; y < Math.max(expected.length, actual.length); y++) {
    const expectedRow = expected[y]
    const actualRow = actual[y]
    if (
      !expectedRow ||
      !actualRow ||
      expectedRow.length !== actualRow.length ||
      !expectedRow.every(
        (cell, x) => cell === actualRow[x] || (cell === CLIPPED && actualRow[x]?.startsWith('▯'))
      )
    ) {
      return { stage, row: y, expected: expectedRow?.join('|'), actual: actualRow?.join('|') }
    }
  }
  return null
}

function expectComparisonParity(
  expected: Buffer,
  actual: Buffer,
  cols: number,
  expectedStart = 0,
  expectedEnd = expected.length,
  actualStart = 0,
  actualEnd = actual.length
): ReturnType<typeof compareBufferRows> {
  const frozen = allocatingRowDiff(
    'parity',
    allocatingBufferRows(expected, expectedStart, expectedEnd, cols),
    allocatingBufferRows(actual, actualStart, actualEnd, cols)
  )
  expect(
    compareBufferRows(
      'parity',
      expected,
      expectedStart,
      expectedEnd,
      actual,
      actualStart,
      actualEnd,
      cols
    )
  ).toEqual(frozen)
  return frozen
}

describe('serialize oracle streaming comparison', () => {
  it('reuses one cell per buffer and stops before rows after the first difference', () => {
    const source = createFuzzTerminal({ cols: 8, rows: 4, scrollback: 0 })
    const replay = createFuzzTerminal({ cols: 8, rows: 4, scrollback: 0 })
    try {
      writeTerminal(source, 'first\r\nsecond\r\nthird\r\nlast')
      writeTerminal(replay, 'wrong\r\nsecond\r\nthird\r\nlast')
      for (const buffer of [source.buffer.active, replay.buffer.active]) {
        const scratch = buffer.getNullCell()
        vi.spyOn(buffer, 'getNullCell').mockReturnValue(scratch)
        const getLine = buffer.getLine.bind(buffer)
        vi.spyOn(buffer, 'getLine').mockImplementation((y) => {
          const line = getLine(y)
          if (line) {
            const getCell = line.getCell.bind(line)
            vi.spyOn(line, 'getCell').mockImplementation((x, cell) => {
              expect(cell).toBe(scratch)
              return getCell(x, cell)
            })
          }
          return line
        })
      }
      const diff = compareBufferRows(
        'visible-grid',
        source.buffer.active,
        0,
        4,
        replay.buffer.active,
        0,
        4,
        8
      )
      expect(diff?.row).toBe(0)
      for (const buffer of [source.buffer.active, replay.buffer.active]) {
        expect(buffer.getNullCell).toHaveBeenCalledTimes(1)
        expect(buffer.getLine).toHaveBeenCalledTimes(2)
        expect(buffer.getLine).toHaveBeenCalledWith(0)
        expect(buffer.getLine).toHaveBeenCalledWith(3)
      }
      writeTerminal(source, '\x1b[2J\x1b[Hchanged')
      expect(diff?.expected).toContain('f·w1·f0:-1·b0:-1·0000000')
    } finally {
      source.dispose()
      replay.dispose()
      vi.restoreAllMocks()
    }
  })

  it.each([false, true])(
    'preserves first-row diagnostics through buffer changes (ConPTY=%s)',
    (conpty) => {
      const source = createFuzzTerminal({ cols: 14, rows: 4, scrollback: 30, conpty })
      const replay = createFuzzTerminal({ cols: 14, rows: 4, scrollback: 30, conpty })
      try {
        for (const [index, data] of [
          'plain \x1b[1;2;3;4;7;8;9mstyled\x1b[0m\r\n',
          '\x1b[38;5;2;48;5;10m palette \x1b[38;2;11;22;33;48;2;44;55;66m RGB \x1b[0m\r\n',
          '\x1b[4:3;9;53m \x1b[0m\x1b[7m \x1b[0m界👩‍💻é\r\n',
          'scroll1\r\nscroll2\r\nscroll3\r\n',
          '\x1b[?1049h\x1b[1;2;3;4;7;8;9malt界\x1b[0m',
          '\x1b[?1049l\x1b[2J\x1b[Hclear'
        ].entries()) {
          writeTerminal(source, data)
          writeTerminal(replay, data)
          for (const [expected, actual] of [
            [source.buffer.active, replay.buffer.active],
            [source.buffer.normal, replay.buffer.normal],
            [source.buffer.alternate, replay.buffer.alternate]
          ]) {
            expect(expectComparisonParity(expected!, actual!, source.cols)).toBeNull()
            expectComparisonParity(expected!, actual!, source.cols + 2, -1, expected!.length + 1)
          }
          const corruption = `\x1b[H\x1b[0mFAULT${index}`
          writeTerminal(replay, corruption)
          expect(
            expectComparisonParity(source.buffer.active, replay.buffer.active, source.cols)
          ).not.toBeNull()
          writeTerminal(source, corruption)
          source.resize(source.cols === 14 ? 9 : 14, 4)
          replay.resize(source.cols, 4)
          expectComparisonParity(source.buffer.active, replay.buffer.active, source.cols)
        }
      } finally {
        source.dispose()
        replay.dispose()
      }
    }
  )

  it('detects every text-flag loss and compares all combinations against the allocating oracle', () => {
    const source = createFuzzTerminal({ cols: 4, rows: 1, scrollback: 0 })
    const replay = createFuzzTerminal({ cols: 4, rows: 1, scrollback: 0 })
    try {
      const sgr = [1, 2, 3, 4, 7, 8, 9]
      const writeFlags = (terminal: Terminal, mask: number): void => {
        const codes = sgr.filter((_code, bit) => (mask & (1 << bit)) !== 0)
        writeTerminal(terminal, `\x1b[H\x1b[0m\x1b[${codes.length ? codes.join(';') : 0}mA\x1b[0mB`)
      }
      for (let mask = 0; mask < 128; mask++) {
        writeFlags(source, mask)
        writeFlags(replay, mask)
        expect(expectComparisonParity(source.buffer.active, replay.buffer.active, 4)).toBeNull()
        for (let bit = 0; bit < sgr.length; bit++) {
          if ((mask & (1 << bit)) !== 0) {
            writeFlags(replay, mask & ~(1 << bit))
            expect(
              expectComparisonParity(source.buffer.active, replay.buffer.active, 4)
            ).not.toBeNull()
          }
        }
      }
    } finally {
      source.dispose()
      replay.dispose()
    }
  })

  it.each([
    ['abc界', 'abc ', 4, false],
    ['abc界', 'abc\x1b[48;2;1;2;3m ', 4, false],
    ['abc ', 'abc界', 4, true],
    ['é', 'è', 8, true],
    ['\x1b[32mA', '\x1b[38;5;2mA', 8, false],
    ['\x1b[42m ', '\x1b[48;5;2m ', 8, false],
    ['\x1b[7;31m ', '\x1b[7;32m ', 8, true],
    ['\x1b[4m\x1b[2J', '\x1b[2J', 8, false],
    ['\x1b[4m ', ' ', 8, true],
    ['\x1b[4m \x1b[0mB', ' B', 8, true],
    ['text\r\n', 'text', 8, false],
    ['text\r\n\x1b[48;2;1;2;3m\x1b[2K', 'text', 8, true]
  ] as const)(
    'preserves blank, clipped and color policy for %j / %j',
    (expected, actual, cols, differs) => {
      const source = createFuzzTerminal({ cols: 8, rows: 4, scrollback: 10 })
      const replay = createFuzzTerminal({ cols: 8, rows: 4, scrollback: 10 })
      try {
        writeTerminal(source, expected)
        writeTerminal(replay, actual)
        expect(
          Boolean(expectComparisonParity(source.buffer.active, replay.buffer.active, cols))
        ).toBe(differs)
        expectComparisonParity(source.buffer.active, replay.buffer.active, cols, -1, 6, -1, 5)
        expectComparisonParity(source.buffer.active, replay.buffer.active, cols, 1, 5, 0, 4)
      } finally {
        source.dispose()
        replay.dispose()
      }
    }
  )
})
