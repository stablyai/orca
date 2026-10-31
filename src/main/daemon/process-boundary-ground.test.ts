import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROCESS_BOUNDARY_GROUND } from '../../shared/terminal-mode-reset-profiles'
import { coldRestorePayloadFromInfo } from './cold-restore-payload-cache'
import { buildDurableCheckpointSnapshot } from './daemon-durable-history-snapshot'
import { DAEMON_RESTORE_SCROLLBACK_ROWS } from './daemon-restore-scrollback-depth'
import { DAEMON_SESSION_SCROLLBACK_ROWS } from './daemon-session-scrollback-window'
import { HeadlessEmulator } from './headless-emulator'
import { getRecoveredHistorySeedSegments } from './terminal-history-seed-segments'
import { TerminalShellRecoveryBarrier } from './terminal-shell-recovery-barrier'
import type { ColdRestoreInfo } from './terminal-history-cold-restore-info'
import type { TerminalSnapshot } from './types'

// Recovery must ground dead-program input modes at both cold restore and a proven crash.

const DEAD_PROCESS_ARMS = '\x1b[?1004h\x1b[?1h\x1b=\x1b[?66h\x1b[?2004h\x1b[?1002h\x1b[?1006h'
const ARMED_TRAILERS = [
  '\x1b[?1004h',
  '\x1b[?1h',
  '\x1b[?66h',
  '\x1b[?2004h',
  '\x1b[?1002h',
  '\x1b[?1006h'
]
const emulators: HeadlessEmulator[] = []

afterEach(() => {
  for (const emulator of emulators.splice(0)) {
    emulator.dispose()
  }
})

function emulator(scrollback: number): HeadlessEmulator {
  const created = new HeadlessEmulator({ cols: 80, rows: 24, scrollback })
  emulators.push(created)
  return created
}

function write(target: HeadlessEmulator, data: string): void {
  expect(target.writeSync(data)).toBe(true)
}

function checkpointOfDeadProcess(tail: string): ColdRestoreInfo {
  const dead = emulator(DAEMON_RESTORE_SCROLLBACK_ROWS)
  write(dead, 'OLD_OUTPUT_1\r\nOLD_OUTPUT_2\r\n$ ')
  write(dead, DEAD_PROCESS_ARMS)
  write(dead, tail)
  const snapshot = dead.getSnapshot()
  return { ...snapshot, cwd: snapshot.cwd ?? '/tmp' }
}

function seededLive(restoreInfo: ColdRestoreInfo): HeadlessEmulator {
  const live = emulator(DAEMON_SESSION_SCROLLBACK_ROWS)
  for (const segment of getRecoveredHistorySeedSegments(restoreInfo)) {
    write(live, segment)
  }
  return live
}

function expectNoArmedInputModes(snapshot: TerminalSnapshot): void {
  expect(snapshot.modes.mouseTracking).toBe(false)
  expect(snapshot.modes.sgrMouseMode).toBe(false)
  expect(snapshot.modes.bracketedPaste).toBe(false)
  expect(snapshot.modes.applicationCursor).toBe(false)
  for (const trailer of ARMED_TRAILERS) {
    expect(snapshot.snapshotAnsi).not.toContain(trailer)
    expect(snapshot.rehydrateSequences).not.toContain(trailer)
  }
}

describe('process boundary ground at a cold restore', () => {
  it('leaves the live window and the first rebased checkpoint with no dead-process input modes', async () => {
    const restoreInfo = checkpointOfDeadProcess('')
    expect(restoreInfo.snapshotAnsi).toContain('\x1b[?1004h')
    const live = seededLive(restoreInfo)
    const liveSnapshot = live.getSnapshot()

    expectNoArmedInputModes(liveSnapshot)
    const checkpoint = await buildDurableCheckpointSnapshot({
      liveSnapshot,
      restoreInfo,
      pendingRecords: [{ kind: 'output', data: 'fresh$ ' }],
      isFirstTake: true
    })
    expectNoArmedInputModes(checkpoint)
  })

  it('rebases a zero-record first fold even when TerminalModes cannot see the stale modes', async () => {
    // Focus and keypad modes are visible only in serialized trailers, outside TerminalModes.
    const dead = emulator(DAEMON_RESTORE_SCROLLBACK_ROWS)
    write(dead, 'OLD_OUTPUT\r\n$ \x1b[?1004h\x1b[?66h')
    const deadSnapshot = dead.getSnapshot()
    const restoreInfo: ColdRestoreInfo = { ...deadSnapshot, cwd: '/tmp' }
    const liveSnapshot = seededLive(restoreInfo).getSnapshot()
    expect(liveSnapshot.modes).toEqual(restoreInfo.modes)

    const checkpoint = await buildDurableCheckpointSnapshot({
      liveSnapshot,
      restoreInfo,
      pendingRecords: [],
      isFirstTake: true
    })

    expect(checkpoint.snapshotAnsi).not.toContain('\x1b[?1004h')
    expect(checkpoint.snapshotAnsi).not.toContain('\x1b[?66h')
  })

  it("keeps the dead process's title off the new process", async () => {
    const dead = emulator(DAEMON_RESTORE_SCROLLBACK_ROWS)
    write(dead, 'OLD_OUTPUT\r\n$ \x1b]0;\u2733 Claude Code\x07')
    const restoreInfo: ColdRestoreInfo = { ...dead.getSnapshot(), cwd: '/tmp' }
    expect(restoreInfo.lastTitle).toBe('\u2733 Claude Code')
    const liveSnapshot = seededLive(restoreInfo).getSnapshot()

    expect(coldRestorePayloadFromInfo(restoreInfo)).not.toHaveProperty('lastTitle')
    // First fold rebuilds from records; a later idle fold may reuse the agreeing disk copy.
    for (const fold of [
      { pendingRecords: [{ kind: 'output' as const, data: 'fresh$ ' }], isFirstTake: true },
      { pendingRecords: [], isFirstTake: false }
    ]) {
      const checkpoint = await buildDurableCheckpointSnapshot({
        liveSnapshot,
        restoreInfo,
        ...fold
      })
      expect(checkpoint.lastTitle).toBeUndefined()
    }
  })

  it('grounds without moving the cursor', () => {
    const live = emulator(DAEMON_SESSION_SCROLLBACK_ROWS)
    write(live, 'OLD_OUTPUT_1\r\n$ ')
    write(live, PROCESS_BOUNDARY_GROUND)
    write(live, 'X')
    expect(live.getBufferTailLines(24)[1]).toBe('$ X')
  })

  // awin verify-11: a reattach after Wake showed the new prompt beside the dead shell's (`$ $`).
  it("starts the new shell's prompt on its own line, keeping the recovered history", () => {
    const live = seededLive(checkpointOfDeadProcess(''))
    write(live, 'NEW_SHELL_PROMPT')

    const rows = live.getBufferTailLines(60).filter((row) => row.length > 0)
    expect(rows.slice(0, 2)).toEqual(['OLD_OUTPUT_1', 'OLD_OUTPUT_2'])
    expect(rows.some((row) => row.trim() === '$')).toBe(true)
    expect(rows.at(-1)).toBe('NEW_SHELL_PROMPT')
  })

  it('never lets the new shell complete a torn escape from the dead process', () => {
    const live = seededLive(checkpointOfDeadProcess('\x1b]0;half-tit'))
    write(live, 'le\x07after-boundary')

    const snapshot = live.getSnapshot()
    expect(snapshot.lastTitle).not.toBe('half-title')
    expect(snapshot.pendingEscapeTailAnsi).toBeUndefined()
    expect(live.getBufferTailLines(24).join('\n')).toContain('leafter-boundary')
  })
})

describe('process boundary ground at a proven crash', () => {
  it('grounds a dead TUI before the shell prompt re-arms its own modes', async () => {
    const live = emulator(DAEMON_SESSION_SCROLLBACK_ROWS)
    const released: string[] = []
    const barrier = new TerminalShellRecoveryBarrier({
      confirmShellForeground: async () => true,
      release: (emission) => {
        released.push(emission.data)
        write(live, emission.data)
      },
      isAlive: () => true
    })

    // Focus armed before the first prompt belongs to the host and survives recovery.
    const data = `\x1b]133;A\x07$ tui\r\n\x1b[?1049h${DEAD_PROCESS_ARMS}TUI\x1b]133;D;137\x07\x1b[?2004h$ `
    barrier.accept({ data, rawStartSeq: 0, rawEndSeq: data.length, transformed: false })

    await vi.waitFor(() => expect(released).toHaveLength(3))
    expect(released[1]).toBe(`\x1b]133;D;137\x07${PROCESS_BOUNDARY_GROUND}`)
    expect(released[2]).toBe('\x1b[?2004h$ ')
    expect(barrier.getOwner()).toBe('shell')
    const snapshot = live.getSnapshot()
    expect(snapshot.modes.alternateScreen).toBe(false)
    expect(snapshot.modes.bracketedPaste).toBe(true)
    expect(snapshot.modes.applicationCursor).toBe(false)
    expect(snapshot.modes.mouseTracking).toBe(false)
    for (const trailer of ['\x1b[?1004h', '\x1b[?66h', '\x1b[?1h', '\x1b[?1006h']) {
      expect(snapshot.snapshotAnsi).not.toContain(trailer)
    }
    expect(live.getBufferTailLines(24).slice(0, 2)).toEqual(['$ tui', '$ '])
  })

  it('pauses on an escape boundary so a mid-proof snapshot has no open OSC', () => {
    const live = emulator(DAEMON_SESSION_SCROLLBACK_ROWS)
    const barrier = new TerminalShellRecoveryBarrier({
      confirmShellForeground: () => new Promise(() => {}),
      release: (emission) => write(live, emission.data),
      isAlive: () => true
    })

    const data = `\x1b[?1049h${DEAD_PROCESS_ARMS}TUI\x1b]133;D;137\x07$ `
    barrier.accept({ data, rawStartSeq: 0, rawEndSeq: data.length, transformed: false })

    expect(live.getSnapshot().pendingEscapeTailAnsi).toBeUndefined()
    barrier.dispose()
  })
})
