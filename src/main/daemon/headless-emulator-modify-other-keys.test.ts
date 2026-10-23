import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'
import { TerminalKittyKeyboardModeTracker } from '../../shared/terminal-kitty-keyboard-mode-tracker'

const PI_TRANSCRIPT = readFileSync(
  join(__dirname, '..', 'runtime', '__fixtures__', 'pi-0-74-modify-other-keys-esc-cr.txt'),
  'utf8'
)

describe('HeadlessEmulator modifyOtherKeys snapshot (STA-7701)', () => {
  let emulator: HeadlessEmulator | null = null
  afterEach(() => {
    emulator?.dispose()
    emulator = null
  })

  it("carries pi's modifyOtherKeys request into the rehydrate a reattaching pane scans", async () => {
    emulator = new HeadlessEmulator({ cols: 100, rows: 30 })
    await emulator.write(PI_TRANSCRIPT)
    const snapshot = emulator.getSnapshot()
    expect(snapshot.modes.modifyOtherKeys).toBe(2)
    expect(snapshot.rehydrateSequences).toContain('\x1b[>4;2m')

    // The startup push is long gone from any replay window; only the rehydrate restates it.
    const mirror = new TerminalKittyKeyboardModeTracker()
    mirror.resetForSnapshot()
    mirror.scanReplay(snapshot.rehydrateSequences + snapshot.snapshotAnsi)
    expect(mirror.modifyOtherKeys).toBe(2)
  })

  it('drops the mode on disarm and on RIS', async () => {
    emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    for (const disarm of ['\x1b[>4;0m', '\x1b[>4m', '\x1bc']) {
      await emulator.write('\x1b[>4;2m')
      expect(emulator.getSnapshot().modes.modifyOtherKeys).toBe(2)
      await emulator.write(disarm)
      const snapshot = emulator.getSnapshot()
      // An explicit zero corrects a client that missed the disarm.
      expect(snapshot.modes.modifyOtherKeys).toBe(0)
      expect(snapshot.rehydrateSequences).toContain('\x1b[>4;0m')
    }
  })

  it('leaves snapshots of panes that never armed the mode unchanged', () => {
    emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    const snapshot = emulator.getSnapshot()
    expect(snapshot.modes.modifyOtherKeys).toBeUndefined()
    expect(snapshot.rehydrateSequences).not.toContain('\x1b[>4')
  })
})
