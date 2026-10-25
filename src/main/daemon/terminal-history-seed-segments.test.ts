import { describe, expect, it } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'
import { buildRehydrateSequences } from './terminal-mode-rehydrate-sequences'
import { getRecoveredHistorySeedSegments } from './terminal-history-seed-segments'
import {
  PROCESS_BOUNDARY_GROUND,
  RESET_GRAPHIC_RENDITION
} from '../../shared/terminal-mode-reset-profiles'
import { buildFreshShellViewportBlankingSequence } from '../../shared/terminal-fresh-shell-viewport'
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

// Assert seed placement here; terminal-mode-reset-profiles.test.ts pins the reset bytes.
const GROUND = PROCESS_BOUNDARY_GROUND
const FRESH_VIEWPORT = buildFreshShellViewportBlankingSequence(24)

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
  it('grounds after the snapshot and drops the dead process torn escape tail', () => {
    const segments = getRecoveredHistorySeedSegments(
      restoreInfo({ pendingEscapeTailAnsi: '\x1b[3' })
    )
    expect(segments).toEqual([
      `${RESET_GRAPHIC_RENDITION}\x1b[?1003h\x1b[?1006h`,
      'user@host ~ $ \x1b[?1003h',
      GROUND,
      FRESH_VIEWPORT
    ])
  })

  it('grounds the alt-screen normal-buffer branch too', () => {
    expect(
      getRecoveredHistorySeedSegments(
        restoreInfo({ modes: { ...ARMED_MODES, alternateScreen: true } })
      )
    ).toEqual([`${RESET_GRAPHIC_RENDITION}user@host ~ $ `, GROUND, FRESH_VIEWPORT])
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

  it('does not touch the live-session reattach payload (mobile scroll gestures)', () => {
    // Live reattach must preserve the active TUI’s modes; only recovery knows that process is dead.
    expect(buildRehydrateSequences(ARMED_MODES)).toBe('\x1b[?1003h\x1b[?1006h')
  })

  it('grounds the pen before re-entering the alternate screen', () => {
    expect(buildRehydrateSequences({ ...ARMED_MODES, alternateScreen: true })).toBe(
      `${RESET_GRAPHIC_RENDITION}\x1b[?1049h\x1b[?1003h\x1b[?1006h`
    )
  })
})
