import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteForegroundEvidence } from '../../shared/foreground-process-evidence'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import type * as TerminalForegroundGroup from './terminal-foreground-group'
import { readLaunchedAgentForeground } from './launched-agent-foreground'

const paneTerminal = vi.hoisted(() => {
  const state: { rows: ProcessTableRow[] | null } = { rows: null }
  return state
})
vi.mock('./terminal-foreground-group', async (importOriginal) => ({
  ...(await importOriginal<typeof TerminalForegroundGroup>()),
  readTerminalProcessRows: vi.fn(async () => paneTerminal.rows)
}))

/** A live observation naming `claude` in the terminal's foreground group. */
function claudeInGroup(capturedAgeMs: number): RemoteForegroundEvidence {
  return {
    verdict: 'live',
    processName: 'claude',
    fence: {
      platform: 'posix',
      shellPid: 40100,
      shellStartTime: 'Fri Oct  2 09:30:01 2026',
      tty: 'ttys007',
      foregroundPgid: 40210
    },
    authorityGeneration: 'gen-1',
    observationEpoch: 1,
    capturedAgeMs,
    ptyId: 'pty-1',
    ptyIncarnationId: 'inc-1'
  }
}

/** The relay names the `sh` that leads the group, as it does behind a wrapper. */
function controllerAnswering(inspect: () => Promise<RemoteForegroundEvidence>) {
  return {
    getForegroundProcess: async () => 'sh',
    confirmForegroundProcess: async () => 'sh',
    confirmShellForeground: async () => false,
    inspectProcess: async () => ({
      foregroundProcess: 'sh',
      hasChildProcesses: true,
      foregroundProcessEvidence: await inspect()
    })
  }
}

const POSIX_SSH = { remote: true, windows: false }

describe('the relay’s foreground group as proof of a launched agent', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // On a loaded host the whole-machine capture can take seconds; it still describes the moment
  // after the read was asked for.
  it('counts a capture begun after the read was asked for, however long `ps` took', async () => {
    const controller = controllerAnswering(async () => {
      vi.advanceTimersByTime(1_800)
      return claudeInGroup(1_800)
    })

    await expect(
      readLaunchedAgentForeground(controller, POSIX_SSH, 'pty-1', 'claude')
    ).resolves.toBe('agent')
  })

  it('takes the relay’s name over a capture reused from before the read was asked for', async () => {
    const controller = controllerAnswering(async () => claudeInGroup(1_500))

    await expect(
      readLaunchedAgentForeground(controller, POSIX_SSH, 'pty-1', 'claude')
    ).resolves.toBe('shell')
  })
})

// Why: this read gates every guarded paste, so it answers from the pane's own terminal and never
// waits on a whole-machine capture, which took seconds a read on a loaded host.
describe('a local pane’s foreground read', () => {
  it('answers from the pane’s own terminal while every whole-machine read is still pending', async () => {
    paneTerminal.rows = [
      { pid: 100, ppid: 1, pgid: 100, tpgid: 200, stat: 'Ss', command: '-zsh' },
      { pid: 200, ppid: 100, pgid: 200, tpgid: 200, stat: 'S+', command: '/opt/bin/claude' }
    ]
    const never = <T>(): Promise<T> => new Promise<T>(() => {})
    const controller = {
      getForegroundProcess: never<string | null>,
      confirmForegroundProcess: never<string | null>,
      confirmShellForeground: never<boolean>,
      inspectProcess: never<never>,
      listProcesses: async () => [{ id: 'pty-1', rootProcessId: 100, cwd: '/repo', title: 'zsh' }]
    }
    const settled = new Promise<string>((resolve) =>
      setTimeout(() => resolve('still waiting'), 1_000)
    )

    await expect(
      Promise.race([
        readLaunchedAgentForeground(
          controller,
          { remote: false, windows: false },
          'pty-1',
          'claude'
        ),
        settled
      ])
    ).resolves.toBe('agent')
  })
})
