import { afterEach, describe, expect, it } from 'vitest'
import { Session } from './session'
import { HeadlessEmulator } from './headless-emulator'
import { coldRestoreInfoFromSnapshot } from './terminal-history-cold-restore-info'
import { getRecoveredHistorySeedSegments } from './terminal-history-seed-segments'
import { DISARM_MOUSE_TRACKING_SEQUENCE } from './terminal-mode-rehydrate-sequences'
import type { SessionMeta } from './terminal-history-metadata'
import type { ColdRestoreInfo } from './terminal-history-cold-restore-info'

// Repro/regression for #12101: a session that dies with mouse tracking armed
// (Claude Code's own TUI, vim, tmux, ...) leaves that mode mirrored in its
// last checkpoint. When a later session is created in its place and seeded
// from that checkpoint (the `historySeedChunks` path used to restore
// scrollback into a freshly spawned shell after e.g. workspace Sleep
// force-kills the old PTY, see #11160), the new session must not inherit
// mouse tracking — its own real subprocess never requested it, and nothing
// would consume the SGR motion reports xterm.js starts sending on every
// pointer move otherwise. Before the fix, the seed's own content (xterm's
// SerializeAddon embeds the DECSET the dead session had armed directly in
// snapshotAnsi/scrollbackAnsi, not just in rehydrateSequences) left the new
// session's mirrored mode stuck on.

const meta: SessionMeta = { cwd: '/home/user' } as SessionMeta

function createMockSubprocess() {
  let onExit: ((code: number) => void) | null = null
  return {
    pid: 12345,
    write() {},
    resize() {},
    pause() {},
    resume() {},
    clear() {},
    kill() {
      onExit?.(0)
    },
    forceKill() {},
    signal() {},
    getForegroundProcess() {
      return null
    },
    onData() {},
    onExit(cb: (code: number) => void) {
      onExit = cb
    },
    dispose() {}
  }
}

function coldRestoreInfoFrom(write: (emu: HeadlessEmulator) => void): ColdRestoreInfo {
  const emu = new HeadlessEmulator({ cols: 80, rows: 24 })
  write(emu)
  const snapshot = emu.getSnapshot({ scrollbackRows: 0 })
  emu.dispose()
  return coldRestoreInfoFromSnapshot(snapshot, null, meta)
}

describe('#12101 seeded session does not inherit stale mouse tracking', () => {
  let session: Session | undefined

  afterEach(() => {
    session?.dispose()
    session = undefined
  })

  it('does not arm mouse tracking on a freshly created session seeded from a dead agent checkpoint', () => {
    // The dead session: Claude Code armed any-motion + SGR mouse for its own
    // TUI and was killed (idle timeout / Sleep) before it could disarm them.
    const restoreInfo = coldRestoreInfoFrom((emu) => {
      emu.write('\x1b[?1003h\x1b[?1006h')
      emu.write('user@host:~$ ')
    })
    expect(restoreInfo.modes.mouseTracking).toBe(true)

    const seedSegments = getRecoveredHistorySeedSegments(restoreInfo)
    const seed = seedSegments.join('')
    // The dead session's enable sequence is still in the recovered content
    // (SerializeAddon bakes it into snapshotAnsi) but the seed now disarms
    // it afterward, so a session built from these exact bytes ends up off.
    expect(seed).toContain('\x1b[?1003h')
    expect(seed.lastIndexOf('\x1b[?1003l')).toBeGreaterThan(seed.lastIndexOf('\x1b[?1003h'))
    expect(seedSegments).toContain(DISARM_MOUSE_TRACKING_SEQUENCE)

    // A brand new session (new PID, plain shell) seeded with that history,
    // exactly like the daemon does when it re-creates a pane's PTY.
    session = new Session({
      sessionId: 'wake-replacement-session',
      cols: 80,
      rows: 24,
      subprocess: createMockSubprocess(),
      shellReadySupported: false,
      historySeedChunks: seedSegments
    })

    const snapshot = session.getSnapshot()
    expect(snapshot?.modes.mouseTracking).toBe(false)

    // The scrollback content itself (the prompt text) still restores.
    expect(seed).toContain('user@host:~$')
  })

  it('does not carry mouse tracking forward when the dead checkpoint had none armed', () => {
    const restoreInfo = coldRestoreInfoFrom((emu) => emu.write('user@host:~$ '))
    expect(restoreInfo.modes.mouseTracking).toBe(false)

    session = new Session({
      sessionId: 'wake-replacement-session-clean',
      cols: 80,
      rows: 24,
      subprocess: createMockSubprocess(),
      shellReadySupported: false,
      historySeedChunks: getRecoveredHistorySeedSegments(restoreInfo)
    })

    expect(session.getSnapshot()?.modes.mouseTracking).toBe(false)
  })

  it('disarms mouse tracking left armed in alternate-screen content too', () => {
    // vim/tmux-style TUIs run in the alt screen; that branch of
    // getRecoveredHistorySeedSegments used to skip rehydrateSequences
    // entirely, but SerializeAddon still embeds the DECSET in the alt
    // buffer's own serialized content.
    const restoreInfo = coldRestoreInfoFrom((emu) => {
      emu.write('\x1b[?1049h\x1b[?1000h')
      emu.write(':wq')
    })
    expect(restoreInfo.modes.alternateScreen).toBe(true)
    expect(restoreInfo.modes.mouseTracking).toBe(true)

    session = new Session({
      sessionId: 'wake-replacement-session-altscreen',
      cols: 80,
      rows: 24,
      subprocess: createMockSubprocess(),
      shellReadySupported: false,
      historySeedChunks: getRecoveredHistorySeedSegments(restoreInfo)
    })

    expect(session.getSnapshot()?.modes.mouseTracking).toBe(false)
  })

  it('keeps the dangling partial-escape tail as the last seed segment, after the disarm', () => {
    // Bug E / #7329: a mid-escape tail must stay last so the new subprocess's
    // own first live bytes complete it, not the disarm sequence.
    const emu = new HeadlessEmulator({ cols: 80, rows: 24 })
    emu.write('\x1b[?1003h')
    emu.write('prompt$ ')
    emu.write('\x1b[3') // dangling partial SGR, no continuation ever arrives
    const snapshot = emu.getSnapshot({ scrollbackRows: 0 })
    emu.dispose()
    expect(snapshot.pendingEscapeTailAnsi).toBe('\x1b[3')

    const restoreInfo = coldRestoreInfoFromSnapshot(snapshot, null, meta)
    const seedSegments = getRecoveredHistorySeedSegments(restoreInfo)
    expect(seedSegments.at(-1)).toBe('\x1b[3')
    // The disarm still lands, before the tail.
    const disarmIndex = seedSegments.indexOf(DISARM_MOUSE_TRACKING_SEQUENCE)
    expect(disarmIndex).toBeGreaterThanOrEqual(0)
    expect(disarmIndex).toBeLessThan(seedSegments.length - 1)
  })

  it('preserves a tail-only normal restore without dropping the seed (#7329)', () => {
    // A normal-screen checkpoint whose only content is a dangling escape:
    // snapshotAnsi and rehydrateSequences are empty. The seed must still carry
    // the tail so the next live bytes complete it. No disarm is added because
    // nothing in the seed armed mouse tracking.
    const restoreInfo: ColdRestoreInfo = {
      snapshotAnsi: '',
      scrollbackAnsi: '',
      rehydrateSequences: '',
      cwd: '/home/user',
      cols: 80,
      rows: 24,
      modes: {
        alternateScreen: false,
        applicationCursor: false,
        bracketedPaste: false,
        mouseTracking: false
      },
      pendingEscapeTailAnsi: '\x1b[3'
    }
    const seedSegments = getRecoveredHistorySeedSegments(restoreInfo)
    expect(seedSegments).toEqual(['\x1b[3'])
    expect(seedSegments).not.toContain(DISARM_MOUSE_TRACKING_SEQUENCE)
  })

  it('does not append an escape tail from a discarded alternate-screen frame', () => {
    // The alt-screen branch restores only the normal buffer; a mid-escape tail
    // belongs to the discarded dead-TUI frame and must not leak into the fresh
    // shell where its next bytes would complete the stale sequence.
    const restoreInfo: ColdRestoreInfo = {
      snapshotAnsi: 'alt frame body',
      scrollbackAnsi: 'normal buffer$ ',
      rehydrateSequences: '\x1b[?1049h\x1b[?1000h',
      cwd: '/home/user',
      cols: 80,
      rows: 24,
      modes: {
        alternateScreen: true,
        applicationCursor: false,
        bracketedPaste: false,
        mouseTracking: true,
        mouseTrackingMode: 'vt200'
      },
      pendingEscapeTailAnsi: '\x1b[3'
    }
    const seedSegments = getRecoveredHistorySeedSegments(restoreInfo)
    expect(seedSegments).toEqual(['normal buffer$ ', DISARM_MOUSE_TRACKING_SEQUENCE])
    expect(seedSegments).not.toContain('\x1b[3')
  })
})
