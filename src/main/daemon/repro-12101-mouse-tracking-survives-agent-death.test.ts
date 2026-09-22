import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { Terminal } from '@xterm/headless'
import { Session } from './session'
import { HistoryManager } from './history-manager'
import { HistoryReader } from './history-reader'
import { getRecoveredHistorySeedSegments } from './terminal-history-seed-segments'
import { iterateTerminalHistorySeedChunks } from './terminal-history-seed-chunks'

// Repro for #12101: a TUI that armed DECSET mouse tracking (Claude Code, vim,
// htop) is force-killed and never emits the matching DECRST. Nothing in the
// daemon substitutes the reset, so `TerminalModes.mouseTracking` is latched into
// the on-disk checkpoint and then re-derived — from the DEAD process's own bytes —
// into every subsequent fresh emulator. The revived pane runs a bare shell that
// never armed mouse reporting, yet its snapshot re-arms it, so pointer motion
// echoes literal SGR reports (^[[<35;col;rowM) into the prompt.
//
// This drives the REAL Session / HeadlessEmulator / TerminalMouseModeMirror /
// buildRehydrateSequences / HistoryManager / HistoryReader, with a fake
// subprocess standing in for node-pty (a real PTY can't be SIGKILLed
// deterministically mid-DECSET in vitest). The kill goes through Session.kill()'s
// real teardown; only killWithDescendantSweep is stubbed so the test never
// signals a real pid.

const killWithDescendantSweepMock = vi.hoisted(() => vi.fn())
vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

// The variant `reattachReplayResetSequence` picks when the pane still looks like a
// live agent, which is exactly the stale state a SIGKILLed agent leaves behind: it
// deliberately OMITS RESET_MOUSE_REPORTING to keep real TUI scroll gestures alive.
import { POST_REPLAY_LIVE_AGENT_REATTACH_RESET } from '../../shared/terminal-mode-reset-profiles'

const ANY_MOTION_TRACKING_ON = '\x1b[?1003h'
const SGR_ENCODING_ON = '\x1b[?1006h'
const ANY_MOTION_TRACKING_OFF = '\x1b[?1003l'
const SGR_ENCODING_OFF = '\x1b[?1006l'

function createFakeSubprocess(foregroundProcess: string) {
  let onData: ((data: string) => void) | null = null
  let onExit: ((code: number) => void) | null = null
  const written: string[] = []
  const signals: string[] = []
  return {
    written,
    signals,
    forceKilled: false,
    pid: 4242,
    getForegroundProcess: () => foregroundProcess,
    write: (data: string) => void written.push(data),
    resize: () => {},
    kill: () => {},
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill(this: { forceKilled: boolean }) {
      this.forceKilled = true
    },
    signal: (sig: string) => void signals.push(sig),
    onData: (cb: (data: string) => void) => void (onData = cb),
    onExit: (cb: (code: number) => void) => void (onExit = cb),
    dispose: () => {},
    /** PTY output — same channel node-pty uses, so Session's real ingest runs. */
    emit: (data: string) => onData?.(data),
    /** SIGKILL reaped: exit fires with no DECRST ever sent. */
    simulateKilledExit: () => onExit?.(-1)
  }
}

/** Session.emitSubprocessOutput awaits xterm's async parse; poll until the
 *  emulator has committed the bytes so snapshots are taken on a settled stream. */
async function waitForEmulatorParse(session: Session): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1))
    if (session.getSnapshot()?.snapshotAnsi.includes('$ ')) {
      return
    }
  }
  throw new Error('setup: emulator never parsed the agent output')
}

describe('#12101 mouse tracking survives the death of the process that armed it', () => {
  let dir: string
  const sessionId = 'repo-1::/Users/dev/feature-branch'

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'repro-12101-'))
    killWithDescendantSweepMock.mockReset()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  it('re-arms mouse reporting in the fresh shell that replaces a force-killed agent', async () => {
    const manager = new HistoryManager(dir)
    const reader = new HistoryReader(dir)

    // 1. A live agent TUI arms any-motion tracking + SGR encoding.
    const agentPty = createFakeSubprocess('claude')
    const agent = new Session({
      sessionId,
      cols: 80,
      rows: 24,
      subprocess: agentPty,
      launchAgent: 'claude',
      shellReadySupported: false
    })
    agentPty.emit(`${ANY_MOTION_TRACKING_ON}${SGR_ENCODING_ON}`)
    agentPty.emit('user@host ~ % claude\r\nclaude> analyzing...\r\nuser@host ~ $ ')
    await waitForEmulatorParse(agent)

    const armed = agent.getSnapshot()
    expect(armed?.modes.mouseTracking).toBe(true)
    expect(armed?.modes.mouseTrackingMode).toBe('any')
    expect(armed?.rehydrateSequences).toContain(ANY_MOTION_TRACKING_ON)

    // 2. Sleep/hibernation takes its final teardown checkpoint while the agent
    //    is still alive with mouse armed (daemon-pty-adapter's {final,teardown}).
    await manager.openSession(sessionId, { cwd: '/Users/dev/feature-branch', cols: 80, rows: 24 })
    await manager.checkpoint(sessionId, armed!)

    // 3. Force-kill. Real Session teardown; the child is reaped without ever
    //    emitting DECRST, and nothing writes one on its behalf.
    agent.kill()
    agentPty.simulateKilledExit()
    agent.dispose() // TerminalHost.reapSession
    expect(killWithDescendantSweepMock).toHaveBeenCalled()
    const teardownBytes = agentPty.written.join('')
    expect(teardownBytes).not.toContain(ANY_MOTION_TRACKING_OFF)
    expect(teardownBytes).not.toContain(SGR_ENCODING_OFF)

    // 4. Wake: the session is still cold-restore eligible (killed with
    //    keepHistory, so endedAt stays null) and a FRESH shell takes its place,
    //    seeded with the recovered history exactly as daemon-server does.
    const restoreInfo = await reader.detectColdRestore(sessionId)
    expect(restoreInfo).not.toBeNull()
    const seedChunks = [
      ...iterateTerminalHistorySeedChunks(getRecoveredHistorySeedSegments(restoreInfo!))
    ]

    const shellPty = createFakeSubprocess('zsh')
    const shell = new Session({
      sessionId,
      cols: 80,
      rows: 24,
      subprocess: shellPty,
      shellReadySupported: false,
      historySeedChunks: seedChunks
    })
    const revived = shell.getSnapshot()
    try {
      // #12101: the replacement shell's OWN state says mouse tracking is on,
      // so every snapshot it serves — reattach, checkpoint, mobile — re-arms it.
      // Soft so one run reports both re-arming channels, not just the first.
      expect.soft(revived?.modes.mouseTracking).toBe(false)
      expect.soft(revived?.modes.mouseTrackingMode).toBe('none')
      expect.soft(revived?.rehydrateSequences).toBe('')
      // Independent second channel: SerializeAddon's own mode trailer re-emits
      // the DECSET from xterm's mouseTrackingMode, so dropping rehydrate alone
      // would not disarm the pane.
      expect.soft(revived?.snapshotAnsi).not.toContain(ANY_MOTION_TRACKING_ON)
    } finally {
      shell.dispose()
    }
  })

  it('leaves the reattached renderer xterm armed against a dead agent (SGR reports into the prompt)', async () => {
    const manager = new HistoryManager(dir)
    const reader = new HistoryReader(dir)

    const agentPty = createFakeSubprocess('claude')
    const agent = new Session({
      sessionId,
      cols: 80,
      rows: 24,
      subprocess: agentPty,
      launchAgent: 'claude',
      shellReadySupported: false
    })
    agentPty.emit(`${ANY_MOTION_TRACKING_ON}${SGR_ENCODING_ON}`)
    agentPty.emit('user@host ~ $ ')
    await waitForEmulatorParse(agent)

    await manager.openSession(sessionId, { cwd: '/Users/dev/feature-branch', cols: 80, rows: 24 })
    await manager.checkpoint(sessionId, agent.getSnapshot()!)
    agent.kill()
    agentPty.simulateKilledExit()
    agent.dispose()

    const restoreInfo = await reader.detectColdRestore(sessionId)
    const shellPty = createFakeSubprocess('zsh')
    const shell = new Session({
      sessionId,
      cols: 80,
      rows: 24,
      subprocess: shellPty,
      shellReadySupported: false,
      historySeedChunks: [
        ...iterateTerminalHistorySeedChunks(getRecoveredHistorySeedSegments(restoreInfo!))
      ]
    })
    const revived = shell.getSnapshot()!

    // Reattach paint into a REAL renderer xterm, using the weakest profile in the
    // family — the one a stale agent title used to select here. The renderer now
    // forces the fresh-shell reset on a cold restore, so this pins the independent
    // half: the seed alone must leave the revived session unarmed, because the
    // daemon emulator's own state is what mobile and every other consumer read.
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    try {
      await new Promise<void>((resolve) => term.write('\x1b[2J\x1b[3J\x1b[H', resolve))
      await new Promise<void>((resolve) =>
        term.write(revived.rehydrateSequences + revived.snapshotAnsi, resolve)
      )
      await new Promise<void>((resolve) =>
        term.write(POST_REPLAY_LIVE_AGENT_REATTACH_RESET, resolve)
      )
      // The observable symptom: a bare `zsh` pane whose xterm reports pointer
      // motion, so every mouse move types ^[[<35;col;rowM at the prompt.
      expect(term.modes.mouseTrackingMode).toBe('none')
    } finally {
      term.dispose()
      shell.dispose()
    }
  })

  it('control: a TUI that DID emit DECRST before exiting restores a clean shell', async () => {
    const manager = new HistoryManager(dir)
    const reader = new HistoryReader(dir)

    const agentPty = createFakeSubprocess('vim')
    const agent = new Session({
      sessionId,
      cols: 80,
      rows: 24,
      subprocess: agentPty,
      shellReadySupported: false
    })
    agentPty.emit(`${ANY_MOTION_TRACKING_ON}${SGR_ENCODING_ON}`)
    agentPty.emit('user@host ~ $ ')
    await waitForEmulatorParse(agent)
    agentPty.emit(`${ANY_MOTION_TRACKING_OFF}${SGR_ENCODING_OFF}`)
    for (let i = 0; i < 50 && agent.getSnapshot()?.modes.mouseTracking !== false; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }

    await manager.openSession(sessionId, { cwd: '/Users/dev/feature-branch', cols: 80, rows: 24 })
    await manager.checkpoint(sessionId, agent.getSnapshot()!)
    agent.kill()
    agentPty.simulateKilledExit()
    agent.dispose()

    const restoreInfo = await reader.detectColdRestore(sessionId)
    const shellPty = createFakeSubprocess('zsh')
    const shell = new Session({
      sessionId,
      cols: 80,
      rows: 24,
      subprocess: shellPty,
      shellReadySupported: false,
      historySeedChunks: [
        ...iterateTerminalHistorySeedChunks(getRecoveredHistorySeedSegments(restoreInfo!))
      ]
    })
    try {
      expect(shell.getSnapshot()?.modes.mouseTracking).toBe(false)
      expect(shell.getSnapshot()?.rehydrateSequences).toBe('')
    } finally {
      shell.dispose()
    }
  })
})
