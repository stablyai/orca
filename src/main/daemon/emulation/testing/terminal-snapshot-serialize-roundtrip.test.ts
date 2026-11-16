// Pin SGR intensity-reset ordering and cursor restoration after wrap-pending replay.
import '../xterm-env-polyfill'
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { HeadlessEmulator } from '../headless-emulator'
import { serializeWithAbsoluteCursor } from '../../../../shared/terminal/replay/terminal-serialize-absolute-cursor'

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

describe('out-of-range SGR state serialization', () => {
  it('emits only the live pen state for a row beyond the normal buffer', async () => {
    const { terminal, addon } = createTerminal()
    await write(terminal, '\x1b[31;44;1m')

    // Frame restoration relies on this undocumented behavior of the vendored addon.
    const outOfRangeRow = terminal.buffer.normal.length
    expect(
      addon.serialize({
        range: { start: outOfRangeRow, end: outOfRangeRow },
        excludeAltBuffer: true,
        excludeModes: true
      })
    ).toBe('\x1b[31;44;1m')
  })
})

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

  it('leaves a wrap-pending source untouched so replay stays wrap-pending', async () => {
    const { terminal, addon } = createTerminal(10, 5)
    await write(terminal, '0123456789')
    // cursorX == cols marks pending wrap; a CUP would clamp and clear it.
    expect(terminal.buffer.active.cursorX).toBe(10)
    const plain = addon.serialize()
    expect(serializeWithAbsoluteCursor(addon, terminal)).toBe(plain)
    const restored = await replay(plain)
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
