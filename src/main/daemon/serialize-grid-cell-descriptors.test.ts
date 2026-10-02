import { describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/headless'
import { bufferRows, cellDescriptor } from './serialize-grid-cell-descriptors'
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
  it.each([false, true])(
    'matches allocating cells across SGR, wide text, buffers and resize (ConPTY=%s)',
    (conpty) => {
      const terminal = createFuzzTerminal({ cols: 14, rows: 4, scrollback: 30, conpty })
      try {
        const writes = [
          'plain \x1b[1;2;3;4;7;8;9mstyled\x1b[0m\r\n',
          '\x1b[38;5;2;48;5;10m palette \x1b[38;2;11;22;33;48;2;44;55;66m RGB \x1b[0m\r\n',
          '\x1b[4:3;9;53m \x1b[0m\x1b[7m \x1b[0m界👩‍💻é\r\n',
          'scroll1\r\nscroll2\r\nscroll3\r\n',
          '\x1b[?1049h\x1b[1;2;3;4;7;8;9malt界\x1b[0m',
          '\x1b[?1049l\x1b[2J\x1b[Hclear'
        ]
        for (const data of writes) {
          writeTerminal(terminal, data)
          for (const buffer of [
            terminal.buffer.normal,
            terminal.buffer.alternate,
            terminal.buffer.active
          ]) {
            expect(bufferRows(buffer, -1, buffer.length + 1, terminal.cols + 2)).toEqual(
              allocatingBufferRows(buffer, -1, buffer.length + 1, terminal.cols + 2)
            )
          }
          terminal.resize(terminal.cols === 14 ? 9 : 14, 4)
          expect(
            bufferRows(terminal.buffer.active, 0, terminal.buffer.active.length, terminal.cols)
          ).toEqual(
            allocatingBufferRows(
              terminal.buffer.active,
              0,
              terminal.buffer.active.length,
              terminal.cols
            )
          )
        }
      } finally {
        terminal.dispose()
      }
    }
  )

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
      expect(bufferRows(terminal.buffer.active, 0, 1, 4)).toEqual(
        allocatingBufferRows(terminal.buffer.active, 0, 1, 4)
      )
    } finally {
      terminal.dispose()
    }
  })

  it('loads every cell into one traversal-local scratch object and retains immutable descriptors', () => {
    const terminal = createFuzzTerminal({ cols: 4, rows: 2, scrollback: 0 })
    try {
      writeTerminal(terminal, '\x1b[1mA\x1b[0m B界')
      const buffer = terminal.buffer.active
      const scratch = buffer.getNullCell()
      const allocate = vi.spyOn(buffer, 'getNullCell').mockReturnValue(scratch)
      const getLine = buffer.getLine.bind(buffer)
      const loaded: unknown[] = []
      vi.spyOn(buffer, 'getLine').mockImplementation((y) => {
        const line = getLine(y)
        if (line) {
          const getCell = line.getCell.bind(line)
          vi.spyOn(line, 'getCell').mockImplementation((x, cell) => {
            loaded.push(cell)
            return getCell(x, cell)
          })
        }
        return line
      })
      const expected = allocatingBufferRows(buffer, 0, 2, 4)
      loaded.length = 0
      const actual = bufferRows(buffer, 0, 2, 4)
      expect(actual).toEqual(expected)
      expect(allocate).toHaveBeenCalledTimes(1)
      expect(loaded).toHaveLength(8)
      expect(loaded.every((cell) => cell === scratch)).toBe(true)
      writeTerminal(terminal, '\x1b[2J\x1b[Hnew')
      bufferRows(buffer, 0, 2, 4)
      expect(actual).toEqual(expected)
    } finally {
      terminal.dispose()
      vi.restoreAllMocks()
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
