import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteForegroundEvidence } from '../../shared/foreground-process-evidence'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import type * as TerminalForegroundGroup from './terminal-foreground-group'
import { resolveRemoteForegroundEvidence } from '../providers/agent-foreground-process-batch'
import { readLaunchedAgentForeground } from './launched-agent-foreground'

const paneTerminal = vi.hoisted(() => {
  const state: { rows: ProcessTableRow[] | null } = { rows: null }
  return state
})
vi.mock('./terminal-foreground-group', async (importOriginal) => ({
  ...(await importOriginal<typeof TerminalForegroundGroup>()),
  readTerminalProcessRows: vi.fn(async () => paneTerminal.rows)
}))

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

  // Capture start time matters; a slow ps result can still describe evidence requested by this read.
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

  function unverifiable(reason: string): RemoteForegroundEvidence {
    return {
      verdict: 'unverifiable',
      reason,
      authorityGeneration: 'gen-1',
      observationEpoch: 1,
      capturedAgeMs: 0,
      ptyId: 'pty-1',
      ptyIncarnationId: 'inc-1'
    }
  }

  // A cached name completes only fresh evidence that saw an agent row; it never fills an observation gap.
  it.each([
    ['ambiguous_foreground_group', 0, 'codex', 'codex', 'agent'],
    ['multiplexer_boundary', 0, 'claude', 'claude', 'agent'],
    // A busy relay's cached snapshot: up to one 500ms TTL old plus its capture.
    ['multiplexer_boundary', 900, 'claude', 'claude', 'agent'],
    ['candidate_start_time_missing', 0, 'claude', 'claude', 'agent'],
    ['ambiguous_foreground_group', 1_500, 'codex', 'codex', 'unknown'],
    // Another agent's name never completes the launched one's evidence.
    ['multiplexer_boundary', 0, 'codex', 'claude', 'unknown'],
    // ps failed (EAGAIN) after the tracker cached `claude` and the foreground became bash.
    ['process_table_unreadable', 0, 'claude', 'claude', 'unknown'],
    ['anchor_missing', 0, 'claude', 'claude', 'unknown'],
    // `sudo -i` with use_pty: the root shell is on a new pty.
    ['tty_boundary', 0, 'sudo', 'claude', 'unknown'],
    ['fence_incomplete', 0, 'claude', 'claude', 'unknown'],
    ['argv_unreadable', 0, 'claude', 'claude', 'unknown'],
    ['a_reason_this_build_does_not_know', 0, 'claude', 'claude', 'unknown'],
    // A relay before same-agent dedupe: npm Codex's node wrapper and native binary read ambiguous, named `node`.
    ['ambiguous_foreground_group', 0, 'node', 'codex', 'agent'],
    ['multiplexer_boundary', 0, 'node', 'codex', 'unknown'],
    // goose is a native binary, so `node` is not its interpreter.
    ['ambiguous_foreground_group', 0, 'node', 'goose', 'unknown']
  ] as const)(
    '%s evidence %ims old with the relay name %s, launching %s: %s',
    async (reason, capturedAgeMs, name, agent, found) => {
      const controller = {
        ...controllerAnswering(async () => ({ ...unverifiable(reason), capturedAgeMs })),
        getForegroundProcess: async () => name,
        confirmForegroundProcess: async () => name
      }

      await expect(
        readLaunchedAgentForeground(controller, POSIX_SSH, 'pty-1', agent)
      ).resolves.toBe(found)
    }
  )

  it('completes structural evidence with a name read now, never the tracker’s display cache', async () => {
    // The tracker cached `codex` at 100ms; Codex exited at 101ms to a bash; the guard runs at 999ms.
    const controller = {
      ...controllerAnswering(async () => ({
        ...unverifiable('ambiguous_foreground_group'),
        capturedAgeMs: 999
      })),
      getForegroundProcess: async () => 'codex',
      confirmForegroundProcess: async () => 'bash'
    }

    await expect(
      readLaunchedAgentForeground(controller, POSIX_SSH, 'pty-1', 'codex')
    ).resolves.toBe('shell')
  })

  it('keeps a host without a fresh read on its name: an older relay’s npm Codex `node`', async () => {
    const { confirmForegroundProcess: _unsupported, ...controller } = {
      ...controllerAnswering(async () => unverifiable('ambiguous_foreground_group')),
      getForegroundProcess: async () => 'node'
    }

    await expect(
      readLaunchedAgentForeground(controller, POSIX_SSH, 'pty-1', 'codex')
    ).resolves.toBe('agent')
  })

  it.each([
    // Past one TTL the agent may have exited since the capture: the read made now decides.
    [990, 'bash', 'shell', 1],
    // A 500ms-cached snapshot plus capture on a near-zero-latency link, the agent still there.
    [600, 'claude', 'agent', 1],
    // Within one TTL the capture alone answers.
    [400, 'bash', 'agent', 0],
    [5_000, 'claude', 'unknown', 0]
  ] as const)(
    'judges live Claude evidence %ims old with a fresh read of %s: %s',
    async (capturedAgeMs, freshName, found, freshReads) => {
      const confirmForegroundProcess = vi.fn(async () => freshName)
      const controller = {
        ...controllerAnswering(async () => claudeInGroup(capturedAgeMs)),
        getForegroundProcess: async () => 'claude',
        confirmForegroundProcess
      }

      await expect(
        readLaunchedAgentForeground(controller, POSIX_SSH, 'pty-1', 'claude')
      ).resolves.toBe(found)
      expect(confirmForegroundProcess).toHaveBeenCalledTimes(freshReads)
    }
  )

  it('judges the name against the host’s capture age, which a slow response cannot shrink', async () => {
    // Captured 400ms before the read was asked for, but 1,500ms old (past the 1s bound) by the time it lands.
    const controller = {
      ...controllerAnswering(async () => {
        vi.advanceTimersByTime(1_100)
        return { ...unverifiable('ambiguous_foreground_group'), capturedAgeMs: 1_500 }
      }),
      getForegroundProcess: async () => 'claude'
    }

    await expect(
      readLaunchedAgentForeground(controller, POSIX_SSH, 'pty-1', 'claude')
    ).resolves.toBe('unknown')
  })

  it.each([
    [
      'npm Codex',
      'codex',
      ['node /usr/local/bin/codex', '/usr/local/lib/node_modules/@openai/codex/bin/codex']
    ],
    [
      'Gemini relaunching itself',
      'gemini',
      ['node /usr/local/bin/gemini', 'node --max-old-space-size=8192 /usr/local/bin/gemini']
    ]
  ] as const)(
    'proves %s from the relay’s two rows of one agent, even when the relay’s name is node',
    async (_label, agent, commands) => {
      const row = (pid: number, ppid: number, command: string): ProcessTableRow => ({
        pid,
        ppid,
        pgid: 40210,
        tpgid: 40210,
        stat: 'S+',
        tty: 'pts/7',
        startTime: `start-${pid}`,
        command
      })
      const evidence = resolveRemoteForegroundEvidence(
        { rootPid: 40100, fallbackProcess: 'zsh' },
        {
          ptyId: 'pty-1',
          ptyIncarnationId: 'inc-1',
          authorityGeneration: 'gen-1',
          observationEpoch: 1,
          capturedAgeMs: 0,
          platform: 'linux'
        },
        [
          { ...row(40100, 1, '-zsh'), pgid: 40100, stat: 'Ss' },
          row(40210, 40100, commands[0]),
          row(40211, 40210, commands[1])
        ]
      )
      const controller = {
        ...controllerAnswering(async () => evidence),
        getForegroundProcess: async () => 'node'
      }

      await expect(
        readLaunchedAgentForeground(controller, POSIX_SSH, 'pty-1', agent)
      ).resolves.toBe('agent')
    }
  )

  it('refuses a stale capture without letting the cached display name restore authority', async () => {
    // zsh → su → root bash → Claude: the tracker cached `claude` just before Claude exited to the root bash.
    const controller = {
      ...controllerAnswering(async () => claudeInGroup(1_500)),
      getForegroundProcess: async () => 'claude'
    }

    await expect(
      readLaunchedAgentForeground(controller, POSIX_SSH, 'pty-1', 'claude')
    ).resolves.toBe('unknown')
  })
})

// Guarded pastes must use terminal-local probes instead of slow whole-machine scans.
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
