/** Shrink without reflow can retain off-grid cells; snapshots must exclude them to prevent wrapped garbage. */
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { HeadlessEmulator } from '../headless-emulator'
import {
  projectTerminalTailLines,
  projectTerminalVisibleLines
} from '../terminal-screen-projection'
import { activateOrcaTerminalUnicodeProvider } from '../../../../shared/terminal/appearance/terminal-unicode-provider'

const WIDE = 135
const NARROW = 48
const ROWS = 6
const NARROW_GRID = Array.from({ length: ROWS }, (_, y) => `narrow${y + 1}`.padEnd(NARROW, ' '))

type Writable = {
  write(data: string): Promise<void> | void
  resize(cols: number, rows: number): void
}

function writeTerminal(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function visibleRows(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active
  return Array.from(
    { length: terminal.rows },
    (_, y) => buffer.getLine(buffer.viewportY + y)?.translateToString(true, 0, terminal.cols) ?? ''
  )
}

async function replayAtNarrowGrid(ansi: string): Promise<Terminal> {
  const restored = new Terminal({ cols: NARROW, rows: ROWS, allowProposedApi: true })
  await writeTerminal(restored, ansi)
  return restored
}

async function paintShrinkRepaint(target: Writable, prefix: string): Promise<void> {
  await target.write(`${prefix}\x1b[48;5;236m`)
  for (let y = 1; y <= ROWS; y++) {
    await target.write(`\x1b[${y};1H${`WIDE${y}`.padEnd(WIDE, '.')}`)
  }
  target.resize(NARROW, ROWS)
  // Repaint without clearing, as OpenTUI does after SIGWINCH.
  for (let y = 1; y <= ROWS; y++) {
    await target.write(`\x1b[${y};1H${`narrow${y}`.padEnd(NARROW, ' ')}`)
  }
}

describe('snapshot after a column shrink', () => {
  it('projects only cells within the applied alternate-screen width', async () => {
    const emu = new HeadlessEmulator({ cols: 10, rows: 4 })
    try {
      await emu.write('\x1b[?1049habcdefghij')
      await emu.write('\x1b[2;1Habcdefgh中abcdefg😀x\x1b[4;1Habc \x1b[4;10Hx')
      emu.resize(9, 4)

      expect(projectTerminalVisibleLines(emu)).toMatchObject({
        lines: ['abcdefghi', 'abcdefgh', 'abcdefg😀', 'abc'],
        tailRows: [
          { wrapped: false, trailingSpaces: 0 },
          { wrapped: false, trailingSpaces: 1 },
          { wrapped: true, trailingSpaces: 0 },
          { wrapped: false, trailingSpaces: 1 }
        ]
      })
    } finally {
      emu.dispose()
    }
  })

  it('projects only the visible composer draft after a shrink', async () => {
    const emu = new HeadlessEmulator({ cols: 10, rows: 4 })
    try {
      await emu.write('\x1b[?1049h──────────\r\n❯ abcdefgh\x1b[2;5H')
      emu.resize(9, 4)

      expect(projectTerminalVisibleLines(emu).draft).toBe('abcdefg')
    } finally {
      emu.dispose()
    }
  })

  it('keeps historical tail text when the grid shrinks without reflow', async () => {
    const emu = new HeadlessEmulator({
      cols: 10,
      rows: 3,
      windowsPty: { backend: 'conpty', buildNumber: 19041 }
    })
    try {
      await emu.write('0123456789\r\none\r\ntwo\r\nthree')
      emu.resize(9, 3)

      expect(projectTerminalTailLines(emu, 4).lines).toEqual(['0123456789', 'one', 'two', 'three'])
    } finally {
      emu.dispose()
    }
  })

  it('restores the visible alternate-screen grid, not the stale pre-shrink cells', async () => {
    const emu = new HeadlessEmulator({ cols: WIDE, rows: ROWS })
    await paintShrinkRepaint(emu, '\x1b[?1049h')
    expect(emu.getVisibleLines()[0]).toMatch(/^narrow1/)
    const snapshot = emu.getSnapshot()

    // Snapshot splitting removes the alternate-screen transition; the restorer must supply it.
    const restored = await replayAtNarrowGrid(
      `${snapshot.scrollbackAnsi ?? ''}\x1b[?1049h${snapshot.snapshotAnsi}`
    )

    expect(snapshot.modes.alternateScreen).toBe(true)
    expect(visibleRows(restored)).toEqual(NARROW_GRID)
    emu.dispose()
  })

  it('blanks a wide cell whose trailing half fell past the grid', async () => {
    const emu = new HeadlessEmulator({ cols: 10, rows: 3 })
    await emu.write('\x1b[?1049h\x1b[1;1Habcdefgh中\x1b[2;1Hrow2\x1b[3;1Hrow3')
    emu.resize(9, 3)

    const rows = await replayEmulatorAt(emu, 9, 3)

    expect(rows).toEqual(['abcdefgh', 'row2', 'row3'])
    emu.dispose()
  })

  it('keeps a wide cell that ends exactly at the grid edge', async () => {
    const emu = new HeadlessEmulator({ cols: 10, rows: 3 })
    await emu.write('\x1b[?1049h\x1b[1;1Habcdefg😀x\x1b[2;1Hrow2\x1b[3;1Hrow3')
    emu.resize(9, 3)

    const rows = await replayEmulatorAt(emu, 9, 3)

    expect(rows).toEqual(['abcdefg😀', 'row2', 'row3'])
    emu.dispose()
  })
})

async function replayEmulatorAt(
  emu: HeadlessEmulator,
  cols: number,
  rows: number
): Promise<string[]> {
  const snapshot = emu.getSnapshot()
  const restored = new Terminal({ cols, rows, allowProposedApi: true })
  restored.loadAddon(new Unicode11Addon())
  activateOrcaTerminalUnicodeProvider(restored)
  await writeTerminal(
    restored,
    `${snapshot.scrollbackAnsi ?? ''}\x1b[?1049h${snapshot.snapshotAnsi}`
  )
  return visibleRows(restored)
}
