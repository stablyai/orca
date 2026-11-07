import { describe, expect, it } from 'vitest'
import { HeadlessEmulator } from '../headless-emulator'

describe('headless emulator unicode widths', () => {
  it('joins ZWJ emoji into one wide pair like the renderer provider', async () => {
    const emulator = new HeadlessEmulator({ cols: 40, rows: 4 })
    // ZWJ joining budgets this glyph as two cells; plain Unicode 11 budgets four.
    await emulator.write('\x1b[H\u{1F469}\u{200D}\u{1F4BB}X')
    await emulator.write('\x1b[1;3HY')
    expect(emulator.getVisibleLines()[0]).toBe('\u{1F469}\u{200D}\u{1F4BB}Y')
    emulator.dispose()
  })
})
