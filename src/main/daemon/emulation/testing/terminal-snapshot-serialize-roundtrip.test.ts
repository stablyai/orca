// Pin SGR intensity-reset ordering and cursor restoration after wrap-pending replay.
import '../xterm-env-polyfill'
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { HeadlessEmulator } from '../headless-emulator'
import {
  readSavedCursorRegister,
  serializeWithAbsoluteCursor
} from '../../../../shared/terminal/replay/terminal-serialize-absolute-cursor'

type TerminalHarness = { terminal: Terminal; addon: SerializeAddon }

function createTerminal(cols = 10, rows = 5, scrollback = 100): TerminalHarness {
  const terminal = new Terminal({ cols, rows, scrollback, allowProposedApi: true })
  const addon = new SerializeAddon()
  terminal.loadAddon(addon)
  return { terminal, addon }
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, () => resolve()))
}

async function replay(data: string, cols = 10, rows = 5, scrollback = 100): Promise<Terminal> {
  const { terminal } = createTerminal(cols, rows, scrollback)
  await write(terminal, data)
  return terminal
}

function cellAt(
  terminal: Terminal,
  viewportRow: number,
  col: number
): NonNullable<
  ReturnType<NonNullable<ReturnType<Terminal['buffer']['active']['getLine']>>['getCell']>
> {
  const buffer = terminal.buffer.active
  const line = buffer.getLine(buffer.baseY + viewportRow)
  if (!line) {
    throw new Error(`no line at viewport row ${viewportRow}`)
  }
  const cell = line.getCell(col)
  if (!cell) {
    throw new Error(`no cell at ${viewportRow},${col}`)
  }
  return cell
}

function visibleText(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active
  const lines: string[] = []
  for (let row = 0; row < terminal.rows; row += 1) {
    lines.push(buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '')
  }
  return lines
}

async function roundTripStyles(source: string): Promise<Terminal> {
  const { terminal, addon } = createTerminal()
  await write(terminal, source)
  return replay(addon.serialize())
}

describe('SGR intensity round-trip (BUG B, addon patch)', () => {
  it('restores bold set immediately after dim is cleared (minimized repro)', async () => {
    const restored = await roundTripStyles('\x1b[2mA\x1b[22m\x1b[1mB')
    const b = cellAt(restored, 0, 1)
    expect(b.getChars()).toBe('B')
    expect(!!b.isBold()).toBe(true)
    expect(!!b.isDim()).toBe(false)
  })
})

describe('cursor restore after wrap-pending replay (BUG C, absolute-cursor hardening)', () => {
  const REPRO = '0123456789\x1b[3;5H'

  it('HeadlessEmulator snapshot restores the exact cursor (minimized repro)', async () => {
    const emulator = new HeadlessEmulator({ cols: 10, rows: 5 })
    expect(emulator.writeSync(REPRO)).toBe(true)
    const snapshot = emulator.getSnapshot()
    const restored = await replay(snapshot.snapshotAnsi)
    expect(restored.buffer.active.cursorX).toBe(4)
    expect(restored.buffer.active.cursorY).toBe(2)
    expect(visibleText(restored)[0]).toBe('0123456789')
    emulator.dispose()
  })

  it('keeps a wrap-pending source wrap-pending after replay', async () => {
    const { terminal, addon } = createTerminal(10, 5)
    await write(terminal, '0123456789')
    // cursorX == cols marks pending wrap; a CUP would clamp and clear it.
    expect(terminal.buffer.active.cursorX).toBe(10)
    const restored = await replay(serializeWithAbsoluteCursor(addon, terminal))
    await write(restored, 'Z')
    expect(visibleText(restored)[1]).toBe('Z')
  })

  it('handles a wrap-pending row that is NOT the final content row', async () => {
    const { terminal, addon } = createTerminal(10, 5)
    await write(terminal, '0123456789ABC\x1b[2;2H')
    expect(terminal.buffer.active.cursorY).toBe(1)
    expect(terminal.buffer.active.cursorX).toBe(1)
    const plainRestore = await replay(addon.serialize())
    const hardenedRestore = await replay(serializeWithAbsoluteCursor(addon, terminal))
    expect(hardenedRestore.buffer.active.cursorX).toBe(1)
    expect(hardenedRestore.buffer.active.cursorY).toBe(1)
    expect(visibleText(hardenedRestore)).toEqual(visibleText(plainRestore))
    expect(hardenedRestore.buffer.active.cursorX).toBe(plainRestore.buffer.active.cursorX)
    expect(hardenedRestore.buffer.active.cursorY).toBe(plainRestore.buffer.active.cursorY)
  })

  it('fixes the wrap-pending off-by-one inside the alt screen too', async () => {
    const { terminal, addon } = createTerminal(10, 5)
    await write(terminal, '\x1b[?1049h0123456789\x1b[3;5H')
    const restored = await replay(serializeWithAbsoluteCursor(addon, terminal))
    expect(restored.buffer.active.type).toBe('alternate')
    expect(restored.buffer.active.cursorX).toBe(4)
    expect(restored.buffer.active.cursorY).toBe(2)
  })

  it('restores scrolled-back buffers with the cursor at its base-relative spot', async () => {
    const { terminal, addon } = createTerminal(10, 3, 50)
    for (let i = 0; i < 8; i += 1) {
      await write(terminal, `line${i}\r\n`)
    }
    await write(terminal, '\x1b[2;3H')
    const source = { x: terminal.buffer.active.cursorX, y: terminal.buffer.active.cursorY }
    const restored = await replay(serializeWithAbsoluteCursor(addon, terminal), 10, 3, 50)
    expect(restored.buffer.active.cursorX).toBe(source.x)
    expect(restored.buffer.active.cursorY).toBe(source.y)
    expect(visibleText(restored)).toEqual(visibleText(terminal))
    expect(restored.buffer.active.length).toBe(terminal.buffer.active.length)
  })
})

describe('pending-wrap cursor after replay (STA-16354)', () => {
  // 10x8 grid, header rows 1-3; ten characters fill a row and leave the wrap pending.
  const HEADER = 'HEADER1\r\nHEADER2\r\nHEADER3'
  const URL = 'https://example.com/live'

  async function replayWithSavedCursor(source: string): Promise<Terminal> {
    const { terminal, addon } = createTerminal(10, 8)
    await write(terminal, source)
    return replay(
      serializeWithAbsoluteCursor(addon, terminal, undefined, readSavedCursorRegister(terminal)),
      10,
      8
    )
  }

  function trimmedText(terminal: Terminal): string[] {
    return visibleText(terminal).map((line) => line.trimEnd())
  }

  it('continues burst output below the header from a headless snapshot inside a scroll region', async () => {
    const emulator = new HeadlessEmulator({ cols: 10, rows: 8 })
    expect(emulator.writeSync(`${HEADER}\x1b[4;8r\x1b[8;1H0123456789`)).toBe(true)
    const restored = await replay(emulator.getSnapshot().snapshotAnsi, 10, 8)
    expect([restored.buffer.active.cursorX, restored.buffer.active.cursorY]).toEqual([10, 7])
    await write(restored, '\r\nburst1\r\nburst2')
    expect(trimmedText(restored)).toEqual([
      'HEADER1',
      'HEADER2',
      'HEADER3',
      '',
      '',
      '0123456789',
      'burst1',
      'burst2'
    ])
    emulator.dispose()
  })

  const cases: {
    name: string
    source: string
    suffix: string
    rows: string[]
    cursor: number[]
  }[] = [
    {
      name: 'with origin mode',
      source: `${HEADER}\x1b[4;8r\x1b[?6h\x1b[5;1H0123456789`,
      suffix: 'X\r\nburst1',
      rows: ['HEADER1', 'HEADER2', 'HEADER3', '', '', '0123456789', 'X', 'burst1'],
      cursor: [6, 7]
    },
    {
      name: 'with a saved cursor',
      source: `${HEADER}\x1b[6;3H\x1b7\x1b[8;1H0123456789`,
      suffix: '\x1b8burst1',
      rows: ['HEADER1', 'HEADER2', 'HEADER3', '', '', '  burst1', '', '0123456789'],
      cursor: [8, 5]
    },
    {
      name: 'on a row above the last written row',
      source: '\x1b[3;1Hzzz\x1b[1;1Habcdefghij',
      suffix: 'X',
      rows: ['abcdefghij', 'X', 'zzz', '', '', '', '', ''],
      cursor: [1, 1]
    },
    {
      name: 'after a styled wide edge cell',
      source: `${HEADER}\x1b[4;8r\x1b[8;1H01234567\x1b[1;31m界\x1b[0;32m`,
      suffix: 'X',
      rows: ['HEADER1', 'HEADER2', 'HEADER3', '', '', '', '01234567界', 'X'],
      cursor: [1, 7]
    },
    {
      name: 'after the edge was erased, keeping the saved cursor',
      source: `${HEADER}\x1b[6;3H\x1b7\x1b[4;8r\x1b[8;1H0123456789\x1b[44m\x1b[2K`,
      suffix: 'X\x1b8Y',
      rows: ['HEADER1', 'HEADER2', 'HEADER3', '', '', '  Y', '', 'X'],
      cursor: [3, 5]
    }
  ]

  for (const { name, source, suffix, rows, cursor } of cases) {
    it(`continues output where the source would ${name}`, async () => {
      const restored = await replayWithSavedCursor(source)
      await write(restored, suffix)
      expect(trimmedText(restored)).toEqual(rows)
      expect([restored.buffer.active.cursorX, restored.buffer.active.cursorY]).toEqual(cursor)
    })
  }

  it('keeps the wrap pending on the alternate screen inside a scroll region', async () => {
    const restored = await replayWithSavedCursor(`\x1b[?1049h${HEADER}\x1b[4;8r\x1b[8;1H0123456789`)
    expect(restored.buffer.active.type).toBe('alternate')
    await write(restored, '\r\nburst1')
    expect(trimmedText(restored)).toEqual([
      'HEADER1',
      'HEADER2',
      'HEADER3',
      '',
      '',
      '',
      '0123456789',
      'burst1'
    ])
  })

  it('keeps the edge cell style and the live pen', async () => {
    const restored = await replayWithSavedCursor(
      `${HEADER}\x1b[4;8r\x1b[8;1H012345678\x1b[1;31mZ\x1b[0;32m`
    )
    await write(restored, 'X')
    const edge = cellAt(restored, 6, 9)
    expect(edge.getChars()).toBe('Z')
    expect(!!edge.isBold()).toBe(true)
    expect(edge.getFgColor()).toBe(1)
    const next = cellAt(restored, 7, 0)
    expect(next.getChars()).toBe('X')
    expect(!!next.isBold()).toBe(false)
    expect(next.getFgColor()).toBe(2)
  })

  it('keeps an erased wrap-pending row empty for copy', async () => {
    const restored = await replayWithSavedCursor('0123456789\x1b[2K')
    expect(visibleText(restored)[0]).toBe('')
    expect(restored.buffer.active.cursorX).toBe(10)
  })

  it('keeps the colors of an inverse blank edge', async () => {
    // A wide glyph that cannot fit leaves an inverse blank at the edge.
    const restored = await replayWithSavedCursor(
      '\x1b[31;44;7m123456789界\x1b[?47h\x1b[1;1H0123456789\x1b[?47l'
    )
    expect(restored.buffer.active.cursorX).toBe(10)
    const edge = cellAt(restored, 0, 9)
    expect(!!edge.isInverse()).toBe(true)
    expect(edge.getFgColor()).toBe(1)
    expect(edge.getBgColor()).toBe(4)
  })

  it('lets a combining mark that arrives after replay join the edge cell', async () => {
    const restored = await replayWithSavedCursor(`${HEADER}\x1b[4;8r\x1b[8;1H012345678e`)
    await write(restored, '́X')
    expect(visibleText(restored).slice(6)).toEqual(['012345678é', 'X'])
  })

  it('does not link reprinted cells to a link left open for later output', async () => {
    const { terminal, addon } = createTerminal(10, 8)
    await write(terminal, `0123456789\x1b]8;;${URL}\x1b\\`)
    const restored = createTerminal(10, 8)
    await write(restored.terminal, serializeWithAbsoluteCursor(addon, terminal))
    await write(restored.terminal, 'X\x1b]8;;\x1b\\')
    // The serializer opens OSC 8 only around linked cells.
    const reserialized = restored.addon.serialize()
    expect(reserialized.startsWith('0123456789')).toBe(true)
    expect(reserialized).toContain(`\x1b]8;;${URL}\x1b\\X`)
  })

  it('does not repaint another row when origin mode cannot address the cursor row', async () => {
    const restored = await replayWithSavedCursor(
      '\x1b[2;4r\x1b[4;1HKEEP\x1b[8;1H0123456789\x1b[?47h\x1b[?6h\x1b[8;1Habcdefghij\x1b[?47l'
    )
    expect(trimmedText(restored)).toEqual(['', '', '', 'KEEP', '', '', '', '0123456789'])
  })
})
