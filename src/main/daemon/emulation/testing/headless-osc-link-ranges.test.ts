import { afterEach, describe, expect, it } from 'vitest'
import { HeadlessEmulator } from '../headless-emulator'

let emulator: HeadlessEmulator | undefined

const link = (uri: string, text: string): string => `\x1b]8;;${uri}\x1b\\${text}\x1b]8;;\x1b\\`

afterEach(() => {
  emulator?.dispose()
  emulator = undefined
})

describe('headless OSC link ranges', () => {
  // Restored ranges have no xterm registration, so the empty-registry shortcut must still map them.

  it('finds links far down a long scrollback, not just the visible screen', async () => {
    emulator = new HeadlessEmulator({ cols: 80, rows: 24, scrollback: 5_000 })
    await emulator.write(`${link('https://example.com/top', 'TOP')}\r\n`)
    await emulator.write('filler\r\n'.repeat(2_000))

    const ranges = emulator.getSnapshot({ scrollbackRows: 5_000 }).oscLinks ?? []
    expect(ranges.map((range) => range.uri)).toContain('https://example.com/top')
  })
})
