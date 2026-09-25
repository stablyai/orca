/**
 * xterm keeps a line's old length after a column shrink whenever it does not
 * reflow (the alternate buffer always; the normal buffer on pre-21376 ConPTY).
 * The snapshot must still describe only the visible grid, or the stale
 * right-hand cells wrap into garbage rows when a restore replays it.
 */
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { HeadlessEmulator } from './headless-emulator'
import { activateOrcaTerminalUnicodeProvider } from '../../shared/terminal-unicode-provider'

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
  // Differential repaint of the narrow grid: no clear, like OpenTUI after SIGWINCH.
  for (let y = 1; y <= ROWS; y++) {
    await target.write(`\x1b[${y};1H${`narrow${y}`.padEnd(NARROW, ' ')}`)
  }
}

describe('snapshot after a column shrink', () => {
  it('restores the visible alternate-screen grid, not the stale pre-shrink cells', async () => {
    const emu = new HeadlessEmulator({ cols: WIDE, rows: ROWS })
    await paintShrinkRepaint(emu, '\x1b[?1049h')
    expect(emu.getVisibleLines()[0]).toMatch(/^narrow1/)
    const snapshot = emu.getSnapshot()

    // The restorer owns the alt-screen transition that the snapshot split strips.
    const restored = await replayAtNarrowGrid(
      `${snapshot.scrollbackAnsi ?? ''}\x1b[?1049h${snapshot.snapshotAnsi}`
    )

    expect(snapshot.modes.alternateScreen).toBe(true)
    expect(visibleRows(restored)).toEqual(NARROW_GRID)
    emu.dispose()
  })

  it('restores the visible normal-buffer grid when the shrink did not reflow', async () => {
    const terminal = new Terminal({
      cols: WIDE,
      rows: ROWS,
      allowProposedApi: true,
      windowsPty: { backend: 'conpty', buildNumber: 19041 }
    })
    const serializer = new SerializeAddon()
    terminal.loadAddon(serializer)
    await paintShrinkRepaint(
      { write: (data) => writeTerminal(terminal, data), resize: (c, r) => terminal.resize(c, r) },
      ''
    )
    expect(visibleRows(terminal)).toEqual(NARROW_GRID)

    const restored = await replayAtNarrowGrid(serializer.serialize())

    expect(visibleRows(restored)).toEqual(NARROW_GRID)
  })

  it.each([
    ['CJK', '中'],
    ['emoji', '😀']
  ])('blanks a %s cell whose trailing half fell past the grid', async (_kind, glyph) => {
    const emu = new HeadlessEmulator({ cols: 10, rows: 3 })
    await emu.write(`\x1b[?1049h\x1b[1;1Habcdefgh${glyph}\x1b[2;1Hrow2\x1b[3;1Hrow3`)
    emu.resize(9, 3)

    const rows = await replayEmulatorAt(emu, 9, 3)

    expect(rows).toEqual(['abcdefgh', 'row2', 'row3'])
    emu.dispose()
  })

  it.each([
    ['CJK', '中'],
    ['emoji', '😀']
  ])('keeps a %s cell that ends exactly at the grid edge', async (_kind, glyph) => {
    const emu = new HeadlessEmulator({ cols: 10, rows: 3 })
    await emu.write(`\x1b[?1049h\x1b[1;1Habcdefg${glyph}x\x1b[2;1Hrow2\x1b[3;1Hrow3`)
    emu.resize(9, 3)

    const rows = await replayEmulatorAt(emu, 9, 3)

    expect(rows).toEqual([`abcdefg${glyph}`, 'row2', 'row3'])
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
