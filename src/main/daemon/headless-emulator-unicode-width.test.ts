import { afterEach, describe, expect, it } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'
import { setTerminalEastAsianAmbiguousWidthMode } from '../../shared/terminal-unicode-provider'

describe('headless emulator unicode widths', () => {
  afterEach(() => {
    setTerminalEastAsianAmbiguousWidthMode('narrow')
  })

  it('advances emoji as two cells so positioned writes land like the renderer', async () => {
    const emulator = new HeadlessEmulator({ cols: 40, rows: 4 })
    // Unicode 11 budgets the robot as two cells; the Unicode 6 default budgets one.
    await emulator.write('\x1b[H\u{1F916}AB')
    await emulator.write('\x1b[1;5HZ')
    expect(emulator.getVisibleLines()[0]).toBe('\u{1F916}ABZ')
    emulator.dispose()
  })

  it('joins ZWJ emoji into one wide pair like the renderer provider', async () => {
    const emulator = new HeadlessEmulator({ cols: 40, rows: 4 })
    // ZWJ joining budgets this glyph as two cells; plain Unicode 11 budgets four.
    await emulator.write('\x1b[H\u{1F469}\u{200D}\u{1F4BB}X')
    await emulator.write('\x1b[1;3HY')
    expect(emulator.getVisibleLines()[0]).toBe('\u{1F469}\u{200D}\u{1F4BB}Y')
    emulator.dispose()
  })

  // Why: wide mode is the SSH/headless twin of Settings → Ambiguous Character Width (#9958).
  it('treats East Asian Ambiguous as two cells when eastAsianAmbiguousWidth is wide', async () => {
    const emulator = new HeadlessEmulator({
      cols: 40,
      rows: 4,
      eastAsianAmbiguousWidth: 'wide'
    })
    // ① is EAW=A (narrow=1 cell); wide budgets two cells so "X" is at column 3.
    await emulator.write('\x1b[H\u{2460}X')
    await emulator.write('\x1b[1;3HY')
    expect(emulator.getVisibleLines()[0]).toBe('\u{2460}Y')
    emulator.dispose()
  })

  it('keeps East Asian Ambiguous one cell when eastAsianAmbiguousWidth is narrow', async () => {
    const emulator = new HeadlessEmulator({ cols: 40, rows: 4, eastAsianAmbiguousWidth: 'narrow' })
    // narrow: ① col1, X col2 — writing Y at col3 leaves X intact → ①XY
    await emulator.write('\x1b[H\u{2460}X')
    await emulator.write('\x1b[1;3HY')
    expect(emulator.getVisibleLines()[0]).toBe('\u{2460}XY')
    emulator.dispose()
  })
})
