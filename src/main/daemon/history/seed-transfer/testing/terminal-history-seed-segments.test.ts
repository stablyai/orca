import { afterEach, describe, expect, it } from 'vitest'
import { HeadlessEmulator } from '../../../emulation/headless-emulator'
import { buildRehydrateSequences } from '../../../emulation/terminal-mode-rehydrate-sequences'
import { getRecoveredHistorySeedSegments } from '../terminal-history-seed-segments'

import type { ColdRestoreInfo } from '../../restoration/terminal-history-cold-restore-info'
import type { TerminalModes } from '../../../protocol/terminal-modes'

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

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
})

describe('getRecoveredHistorySeedSegments', () => {
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

  it('starts a POSIX shell below history whose cursor was parked above it', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const emulator = new HeadlessEmulator({ cols: 20, rows: 4 })
    try {
      const segments = getRecoveredHistorySeedSegments(
        restoreInfo({
          // An agent leaves its cursor in its input box, above the footer rows.
          snapshotAnsi: 'ONE\r\nTWO\r\nBOX\r\nFOOTER\x1b[3;3H',
          rehydrateSequences: '',
          rows: 4,
          modes: {
            ...ARMED_MODES,
            mouseTracking: false,
            mouseTrackingMode: 'none',
            sgrMouseMode: false
          }
        })
      )
      for (const segment of [...segments, '$ ']) {
        expect(emulator.writeSync(segment)).toBe(true)
      }
      expect(emulator.getVisibleLines().map((line) => line.trimEnd())).toEqual([
        'TWO',
        'BOX',
        'FOOTER',
        '$'
      ])
    } finally {
      emulator.dispose()
    }
  })
})
