import { describe, expect, it } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'

describe('HeadlessEmulator kitty keyboard flags', () => {
  it('stays at zero until the PTY pushes the protocol', async () => {
    const emulator = new HeadlessEmulator({ cols: 80, rows: 24 })

    expect(emulator.kittyKeyboardFlags()).toBe(0)
    await emulator.applyKittyKeyboardFlags(1)

    expect(emulator.kittyKeyboardFlags()).toBe(1)
  })
})
