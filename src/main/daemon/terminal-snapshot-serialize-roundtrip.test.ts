// Round-trip guards for two @xterm/addon-serialize defects that garbled
// hidden-terminal snapshot restores (serialize a buffer, replay into a fresh
// identical terminal, compare):
//
// BUG B (fixed by config/patches/@xterm__addon-serialize@*.patch): the SGR
// attribute diff emitted bold/dim set params before the shared intensity
// reset 22, so "1;22" wiped a freshly set bold and a bare "22" dropped a
// still-set bold/dim.
//
// BUG C (hardened Orca-side via serializeWithAbsoluteCursor): a final content
// row filled exactly to the right margin leaves replay wrap-pending, and the
// addon's RELATIVE cursor restore then lands one column short.
import './xterm-env-polyfill'
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { HeadlessEmulator } from './headless-emulator'
import { serializeWithAbsoluteCursor } from '../../shared/terminal-serialize-absolute-cursor'

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

  it('keeps bold when dim is dropped from a bold+dim run', async () => {
    const restored = await roundTripStyles('\x1b[1;2mA\x1b[22m\x1b[1mB')
    const b = cellAt(restored, 0, 1)
    expect(!!b.isBold()).toBe(true)
    expect(!!b.isDim()).toBe(false)
  })

  it('keeps dim when bold is dropped from a bold+dim run', async () => {
    const restored = await roundTripStyles('\x1b[1;2mA\x1b[22m\x1b[2mB')
    const b = cellAt(restored, 0, 1)
    expect(!!b.isDim()).toBe(true)
    expect(!!b.isBold()).toBe(false)
  })

  it('non-regression: bold after normal text', async () => {
    const restored = await roundTripStyles('A\x1b[1mB')
    expect(!!cellAt(restored, 0, 0).isBold()).toBe(false)
    expect(!!cellAt(restored, 0, 1).isBold()).toBe(true)
  })

  it('non-regression: dim after bold', async () => {
    const restored = await roundTripStyles('\x1b[1mA\x1b[22m\x1b[2mB')
    const a = cellAt(restored, 0, 0)
    const b = cellAt(restored, 0, 1)
    expect(!!a.isBold()).toBe(true)
    expect(!!a.isDim()).toBe(false)
    expect(!!b.isDim()).toBe(true)
    expect(!!b.isBold()).toBe(false)
  })

  it('non-regression: bold+dim accumulation survives', async () => {
    const restored = await roundTripStyles('\x1b[1mA\x1b[2mB')
    const b = cellAt(restored, 0, 1)
    expect(!!b.isBold()).toBe(true)
    expect(!!b.isDim()).toBe(true)
  })

  it('non-regression: italic after underline is cleared (dedicated resets)', async () => {
    const restored = await roundTripStyles('\x1b[4mA\x1b[24m\x1b[3mB')
    const b = cellAt(restored, 0, 1)
    expect(!!b.isItalic()).toBe(true)
    expect(!!b.isUnderline()).toBe(false)
  })

  it('non-regression: underline after italic is cleared (dedicated resets)', async () => {
    const restored = await roundTripStyles('\x1b[3mA\x1b[23m\x1b[4mB')
    const b = cellAt(restored, 0, 1)
    expect(!!b.isUnderline()).toBe(true)
    expect(!!b.isItalic()).toBe(false)
  })

  it('non-regression: underline dropped alongside bold set', async () => {
    const restored = await roundTripStyles('\x1b[4mA\x1b[24m\x1b[1;4mB\x1b[24mC')
    const c = cellAt(restored, 0, 2)
    expect(!!c.isBold()).toBe(true)
    expect(!!c.isUnderline()).toBe(false)
  })
})

describe('cursor restore after wrap-pending replay (BUG C, absolute-cursor hardening)', () => {
  const REPRO = '0123456789\x1b[3;5H'

  it('documents the upstream defect: plain serialize lands one column short', async () => {
    // Why this pin: the Orca hardening exists only because of this relative-
    // restore defect. If an addon bump makes this fail, the hardening can go.
    const { terminal, addon } = createTerminal(10, 5)
    await write(terminal, REPRO)
    expect(terminal.buffer.active.cursorX).toBe(4)
    const restored = await replay(addon.serialize())
    expect(restored.buffer.active.cursorX).toBe(3)
  })

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

  it('serializeWithAbsoluteCursor restores the exact cursor', async () => {
    const { terminal, addon } = createTerminal(10, 5)
    await write(terminal, REPRO)
    const restored = await replay(serializeWithAbsoluteCursor(addon, terminal))
    expect(restored.buffer.active.cursorX).toBe(4)
    expect(restored.buffer.active.cursorY).toBe(2)
  })

  it('never changes already-correct restores at various cursor positions', async () => {
    const positions = ['\x1b[1;1H', '\x1b[2;4H', '\x1b[5;10H', '\x1b[4;1H']
    for (const cup of positions) {
      const { terminal, addon } = createTerminal(10, 5)
      await write(terminal, `hello\r\nworld${cup}`)
      const plainRestore = await replay(addon.serialize())
      const hardenedRestore = await replay(serializeWithAbsoluteCursor(addon, terminal))
      expect(hardenedRestore.buffer.active.cursorX).toBe(terminal.buffer.active.cursorX)
      expect(hardenedRestore.buffer.active.cursorY).toBe(terminal.buffer.active.cursorY)
      expect(hardenedRestore.buffer.active.cursorX).toBe(plainRestore.buffer.active.cursorX)
      expect(hardenedRestore.buffer.active.cursorY).toBe(plainRestore.buffer.active.cursorY)
      expect(visibleText(hardenedRestore)).toEqual(visibleText(plainRestore))
    }
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
    // Row 0 fills to the margin and wraps into row 1, then the cursor moves.
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

  it('restores alt-screen snapshots without disturbing correct positioning', async () => {
    const { terminal, addon } = createTerminal(10, 5)
    await write(terminal, 'shell$\x1b[?1049h\x1b[2J\x1b[HTUI ROW\x1b[2;3H')
    expect(terminal.buffer.active.type).toBe('alternate')
    const restored = await replay(serializeWithAbsoluteCursor(addon, terminal))
    expect(restored.buffer.active.type).toBe('alternate')
    expect(restored.buffer.active.cursorX).toBe(2)
    expect(restored.buffer.active.cursorY).toBe(1)
    expect(visibleText(restored)[0]).toBe('TUI ROW')
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

  it('keeps empty buffers serializing to an empty string', async () => {
    const { terminal, addon } = createTerminal(10, 5)
    expect(addon.serialize()).toBe('')
    expect(serializeWithAbsoluteCursor(addon, terminal)).toBe('')
  })
})
