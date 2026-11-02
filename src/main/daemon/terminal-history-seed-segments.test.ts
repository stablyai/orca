import { describe, expect, it } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'
import { buildRehydrateSequences } from './terminal-mode-rehydrate-sequences'
import { getRecoveredHistorySeedSegments } from './terminal-history-seed-segments'

import type { ColdRestoreInfo } from './terminal-history-cold-restore-info'
import type { TerminalModes } from './types'

const ARMED_MODES: TerminalModes = {
  bracketedPaste: false,
  mouseTracking: true,
  mouseTrackingMode: 'any',
  sgrMouseMode: true,
  applicationCursor: false,
  alternateScreen: false
}

function restoreInfo(overrides: Partial<ColdRestoreInfo> = {}): ColdRestoreInfo {
  return {
    snapshotAnsi: 'user@host ~ $ \x1b[?1003h',
    scrollbackAnsi: 'user@host ~ $ ',
    rehydrateSequences: buildRehydrateSequences(ARMED_MODES),
    cwd: '/w',
    cols: 80,
    rows: 24,
    modes: ARMED_MODES,
    ...overrides
  }
}

describe('getRecoveredHistorySeedSegments', () => {
  it('recovers nothing when a torn escape is the only recovered data', () => {
    expect(
      getRecoveredHistorySeedSegments(
        restoreInfo({
          scrollbackAnsi: '',
          snapshotAnsi: '',
          rehydrateSequences: '',
          pendingEscapeTailAnsi: '\x1b[3'
        })
      )
    ).toEqual([])
  })

  it('leaves the revived emulator unarmed while preserving scrollback (#12101)', () => {
    const emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    try {
      for (const segment of getRecoveredHistorySeedSegments(restoreInfo())) {
        expect(emulator.writeSync(segment)).toBe(true)
      }
      const snapshot = emulator.getSnapshot()
      expect(snapshot.modes.mouseTracking).toBe(false)
      expect(snapshot.modes.mouseTrackingMode).toBe('none')
      expect(snapshot.modes.sgrMouseMode).toBe(false)
      expect(snapshot.rehydrateSequences).toBe('')
      expect(snapshot.snapshotAnsi).not.toContain('\x1b[?1003h')
      expect(snapshot.snapshotAnsi).toContain('user@host ~ $')
    } finally {
      emulator.dispose()
    }
  })
})
