import { describe, expect, it } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'
import { buildRehydrateSequences } from './terminal-mode-rehydrate-sequences'
import { getRecoveredHistorySeedSegments } from './terminal-history-seed-segments'
import { COLD_RESTORE_SEED_MODE_RESET } from '../../shared/terminal-mode-reset-profiles'
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

// Why import rather than restate: the exact bytes are pinned in
// terminal-mode-reset-profiles.test.ts; this suite pins placement within the seed.
const MOUSE_OFF = COLD_RESTORE_SEED_MODE_RESET

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
  it('disarms mouse reporting after the snapshot but before the torn escape tail', () => {
    const segments = getRecoveredHistorySeedSegments(
      restoreInfo({ pendingEscapeTailAnsi: '\x1b[3' })
    )
    expect(segments).toEqual([
      '\x1b[?1003h\x1b[?1006h',
      'user@host ~ $ \x1b[?1003h',
      MOUSE_OFF,
      '\x1b[3'
    ])
  })

  it('disarms mouse reporting on the alt-screen normal-buffer branch too', () => {
    expect(
      getRecoveredHistorySeedSegments(
        restoreInfo({ modes: { ...ARMED_MODES, alternateScreen: true } })
      )
    ).toEqual(['user@host ~ $ ', MOUSE_OFF])
  })

  it('stays empty when there is no recovered normal buffer', () => {
    expect(
      getRecoveredHistorySeedSegments(
        restoreInfo({
          modes: { ...ARMED_MODES, alternateScreen: true },
          scrollbackAnsi: '',
          snapshotAnsi: ''
        })
      )
    ).toEqual([])
  })

  it('keeps the empty "nothing to recover" sentinel on the normal-screen branch', () => {
    // Why: daemon-pty-adapter keys the probe-race kill+respawn and the history
    // re-anchor on `length === 0`, so the reset must never be the only segment.
    expect(
      getRecoveredHistorySeedSegments(
        restoreInfo({
          modes: { ...ARMED_MODES, mouseTracking: false, mouseTrackingMode: 'none' },
          scrollbackAnsi: '',
          snapshotAnsi: '',
          rehydrateSequences: ''
        })
      )
    ).toEqual([])
  })

  it('keeps a torn escape last when it is the only recovered data', () => {
    expect(
      getRecoveredHistorySeedSegments(
        restoreInfo({
          scrollbackAnsi: '',
          snapshotAnsi: '',
          rehydrateSequences: '',
          pendingEscapeTailAnsi: '\x1b[3'
        })
      )
    ).toEqual([MOUSE_OFF, '\x1b[3'])
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

  it('does not touch the live-session reattach payload (mobile scroll gestures)', () => {
    // Why: only recovery seeding knows the arming TUI is dead; live reattach
    // snapshots must keep re-arming or an alt-screen TUI loses scroll forever.
    expect(buildRehydrateSequences(ARMED_MODES)).toBe('\x1b[?1003h\x1b[?1006h')
  })
})
