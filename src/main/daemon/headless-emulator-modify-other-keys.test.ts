import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'
import { TerminalKittyKeyboardModeTracker } from '../../shared/terminal/protocol/input-modes/terminal-kitty-keyboard-mode-tracker'

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

    // Only rehydration can recover a startup mode push that has left the replay window.
    const mirror = new TerminalKittyKeyboardModeTracker()
    mirror.resetForSnapshot()
    mirror.scanReplay(snapshot.rehydrateSequences + snapshot.snapshotAnsi)
    expect(mirror.modifyOtherKeys).toBe(2)
  })
})
