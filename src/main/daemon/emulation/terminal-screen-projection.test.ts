import { expect, it } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'
import { projectTerminalVisibleLines } from './terminal-screen-projection'

it('distinguishes a recognized empty composer from an unrecognized input row', async () => {
  const emulator = new HeadlessEmulator({ cols: 80, rows: 10 })
  try {
    await emulator.write('\x1b[2J\x1b[H──────────\r\n❯ \r\n──────────\x1b[2;3H')
    expect(projectTerminalVisibleLines(emulator).draft).toBe('')
    await emulator.write('\x1b[2J\x1b[Hcustom prompt with unsent text')
    expect(projectTerminalVisibleLines(emulator).draft).toBeUndefined()
  } finally {
    emulator.dispose()
  }
})
