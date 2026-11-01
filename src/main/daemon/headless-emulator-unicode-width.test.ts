import { describe, expect, it } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'

describe('headless emulator unicode widths', () => {
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

  it('advances circled numbers as two cells so trailing ASCII does not overlap', async () => {
    const emulator = new HeadlessEmulator({ cols: 40, rows: 4 })
    // ① is EAW=Ambiguous — Unicode 11 budgets it 1 cell while fonts draw it
    // full-width, so ①-then-ASCII overlaps. Widened to 2 cells, "A" is at
    // column 3, "B" at 4, and column 5 lands just past "B".
    await emulator.write('\x1b[H①AB')
    await emulator.write('\x1b[1;5HZ')
    expect(emulator.getVisibleLines()[0]).toBe('①ABZ')
    emulator.dispose()
  })
})
