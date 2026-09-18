import { afterEach, describe, expect, it } from 'vitest'
import { RESET_GRAPHIC_RENDITION } from '../../shared/terminal-mode-reset-profiles'
import { HeadlessEmulator } from './headless-emulator'
import { coldRestoreInfoFromSnapshot } from './terminal-history-cold-restore-info'
import {
  buildRehydrateSequences,
  omitMouseTrackingFromRehydrateSequences
} from './terminal-mode-rehydrate-sequences'
import type { TerminalModes } from './types'

const ARMED_MOUSE: TerminalModes = {
  bracketedPaste: true,
  mouseTracking: true,
  mouseTrackingMode: 'any',
  sgrMouseMode: true,
  applicationCursor: false,
  alternateScreen: true
}

function expectNoMouseRehydrate(sequences: string): void {
  expect(sequences).not.toContain('\x1b[?9h')
  expect(sequences).not.toContain('\x1b[?1000h')
  expect(sequences).not.toContain('\x1b[?1002h')
  expect(sequences).not.toContain('\x1b[?1003h')
  expect(sequences).not.toContain('\x1b[?1006h')
  expect(sequences).not.toContain('\x1b[?1016h')
}

describe('buildRehydrateSequences', () => {
  it('omits any-event SGR mouse tracking while keeping alt-screen and paste (#18424)', () => {
    const sequences = buildRehydrateSequences(ARMED_MOUSE)
    expect(sequences).toContain(`${RESET_GRAPHIC_RENDITION}\x1b[?1049h`)
    expect(sequences).toContain('\x1b[?2004h')
    expectNoMouseRehydrate(sequences)
  })

  it('omits every mouse protocol the generator used to restore', () => {
    for (const mouseTrackingMode of ['x10', 'vt200', 'drag', 'any'] as const) {
      expectNoMouseRehydrate(
        buildRehydrateSequences({
          ...ARMED_MOUSE,
          alternateScreen: false,
          bracketedPaste: false,
          mouseTrackingMode
        })
      )
    }
  })

  it('omits leftover SGR encoding when reporting is already off', () => {
    const sequences = buildRehydrateSequences({
      bracketedPaste: false,
      mouseTracking: false,
      mouseTrackingMode: 'none',
      sgrMouseMode: true,
      applicationCursor: false,
      alternateScreen: false
    })
    expect(sequences).toBe('')
  })

  it('omits SGR-pixels encoding as well as SGR', () => {
    const sequences = buildRehydrateSequences({
      ...ARMED_MOUSE,
      sgrMouseMode: false,
      sgrMousePixelsMode: true
    })
    expect(sequences).toContain('\x1b[?1049h')
    expectNoMouseRehydrate(sequences)
  })
})

describe('omitMouseTrackingFromRehydrateSequences', () => {
  it('strips baked-in mouse DECSET from an older checkpoint string', () => {
    const stored = `${RESET_GRAPHIC_RENDITION}\x1b[?1049h\x1b[?2004h\x1b[?1003h\x1b[?1006h`
    const sequences = omitMouseTrackingFromRehydrateSequences(stored)
    expect(sequences).toBe(`${RESET_GRAPHIC_RENDITION}\x1b[?1049h\x1b[?2004h`)
  })
})

describe('cold restore of a checkpoint that recorded mouse tracking', () => {
  it('does not replay ?1003h/?1006h from stored rehydrateSequences (#18424)', () => {
    const info = coldRestoreInfoFromSnapshot(
      {
        snapshotAnsi: 'user@host ~ $ ',
        scrollbackAnsi: '',
        rehydrateSequences: `${RESET_GRAPHIC_RENDITION}\x1b[?1049h\x1b[?2004h\x1b[?1003h\x1b[?1006h`,
        cols: 80,
        rows: 24,
        modes: ARMED_MOUSE
      },
      '/w',
      {
        cwd: '/w',
        cols: 80,
        rows: 24,
        startedAt: '2026-09-03T00:00:00.000Z',
        endedAt: null,
        exitCode: null
      }
    )
    expect(info.rehydrateSequences).toContain('\x1b[?1049h')
    expect(info.rehydrateSequences).toContain('\x1b[?2004h')
    expectNoMouseRehydrate(info.rehydrateSequences)
    expect(info.modes.mouseTracking).toBe(true)
    expect(info.modes.mouseTrackingMode).toBe('any')
    expect(info.modes.sgrMouseMode).toBe(true)
  })
})

describe('HeadlessEmulator rehydrateSequences', () => {
  let emulator: HeadlessEmulator

  afterEach(() => {
    emulator?.dispose()
  })

  it('does not put armed mouse tracking into a snapshot rehydrate prefix', async () => {
    emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    await emulator.write('\x1b[?1049h\x1b[?2004h\x1b[?1003h\x1b[?1006h')

    const snapshot = emulator.getSnapshot()
    expect(snapshot.modes.mouseTracking).toBe(true)
    expect(snapshot.modes.mouseTrackingMode).toBe('any')
    expect(snapshot.modes.sgrMouseMode).toBe(true)
    expect(snapshot.rehydrateSequences).toContain('\x1b[?1049h')
    expect(snapshot.rehydrateSequences).toContain('\x1b[?2004h')
    expectNoMouseRehydrate(snapshot.rehydrateSequences)
  })
})
