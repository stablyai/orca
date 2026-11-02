import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { Terminal } from '@xterm/headless'
import { Session } from './session'
import { TerminalSessionTeardown } from './terminal-session-teardown'
import { HistoryManager } from './history-manager'
import { HistoryReader } from './history-reader'
import { getRecoveredHistorySeedSegments } from './terminal-history-seed-segments'
import { iterateTerminalHistorySeedChunks } from './terminal-history-seed-chunks'

// Guard fresh-shell restoration against mouse modes persisted before an agent died without disarming.

const killWithDescendantSweepMock = vi.hoisted(() => vi.fn())
vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

import { POST_REPLAY_LIVE_AGENT_REATTACH_RESET } from '../../shared/terminal-mode-reset-profiles'

const ANY_MOTION_TRACKING_ON = '\x1b[?1003h'
const SGR_ENCODING_ON = '\x1b[?1006h'

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
    emit: (data: string) => onData?.(data),
    simulateKilledExit: () => onExit?.(-1)
  }
}

/** Wait for the asynchronous emulator parse before reading a snapshot. */
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
    void new TerminalSessionTeardown(new Map([[sessionId, agent]])).killSession(
      sessionId,
      agent,
      false
    )
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

    // Use the mouse-preserving live-agent reset to prove the recovered seed is already disarmed.
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    try {
      await new Promise<void>((resolve) => term.write('\x1b[2J\x1b[3J\x1b[H', resolve))
      await new Promise<void>((resolve) =>
        term.write(revived.rehydrateSequences + revived.snapshotAnsi, resolve)
      )
      await new Promise<void>((resolve) =>
        term.write(POST_REPLAY_LIVE_AGENT_REATTACH_RESET, resolve)
      )
      expect(term.modes.mouseTrackingMode).toBe('none')
    } finally {
      term.dispose()
      shell.dispose()
    }
  })
})
