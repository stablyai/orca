/**
 * An agent that exits at startup leaves its shell at a prompt that turns bracketed paste on, which
 * is the same signal an agent's composer gives. Driven through the launch's own readiness wait,
 * foreground read and write guard, with each host answering the way it does after the exit.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deliverTerminalAgentLaunchPrompt } from './rpc/methods/agent-launch-terminal-prompt'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import { readLaunchedAgentForeground } from './launched-agent-foreground'
import type * as TerminalForegroundGroup from './terminal-foreground-group'
import { waitForWorktreeStartupDraft } from './runtime-worktree-startup-readiness'

const PTY_ID = 'pty-1'

// What `ps` limited to the pane's terminal answers; the verdict over it stays the real one.
const paneTerminal = vi.hoisted(() => {
  const state: { rows: ProcessTableRow[] | null } = { rows: null }
  return state
})
vi.mock('./terminal-foreground-group', async (importOriginal) => ({
  ...(await importOriginal<typeof TerminalForegroundGroup>()),
  readTerminalProcessRows: vi.fn(async () => paneTerminal.rows)
}))

/** A macOS pane under `login` whose terminal `group` holds, with `jobs` launched from its zsh. */
function loginPane(
  group: number,
  jobs: { pid: number; command: string }[] = []
): ProcessTableRow[] {
  return [
    {
      pid: 100,
      ppid: 1,
      pgid: 100,
      tpgid: group,
      stat: 'Ss',
      command: '/usr/bin/login -flpq user'
    },
    { pid: 101, ppid: 100, pgid: 101, tpgid: group, stat: 'S', command: '-zsh' },
    ...jobs.map(({ pid, command }) => ({
      pid,
      ppid: 101,
      pgid: pid,
      tpgid: group,
      stat: 'S+',
      command
    }))
  ]
}
const SHELL_HANDOFF = '\x1b[?2004l'

/** zsh's prompt, the launch line it runs, then its prompt again once that command exited. */
function zshRunsLaunchLineThatExits(): string[] {
  const zsh = readFileSync(join(__dirname, '__fixtures__', 'zsh-prompt-runs-command.txt'), 'utf8')
  const split = zsh.indexOf('\n', zsh.indexOf(SHELL_HANDOFF)) + 1
  return [zsh.slice(0, split), 'stub: crashing at startup\r\n', zsh.slice(split)]
}

/** Git Bash and WSL's bash: readline turns bracketed paste on at each prompt. */
function bashRunsLaunchLineThatExits(): string[] {
  return [
    '\x1b[?2004hqa@host:~$ claude\r\n\x1b[?2004l\r',
    'stub: crashing at startup\r\n',
    '\x1b[?2004hqa@host:~$ '
  ]
}

type HostAnswers = {
  agent?: 'claude' | 'grok'
  host: { remote: boolean; windows: boolean }
  cached: string | null
  scanned: string | null
  /** The pane terminal's processes, for a local macOS or Linux host. */
  rows?: ProcessTableRow[]
  shellAlone: boolean
}

const HOSTS: [string, HostAnswers, () => string[]][] = [
  // The shell keeps other processes in its job, so the shell-alone check never answers.
  [
    'Windows Git Bash',
    {
      host: { remote: false, windows: true },
      cached: 'claude',
      scanned: 'bash',
      shellAlone: false
    },
    bashRunsLaunchLineThatExits
  ],
  // The QA stub: a `grok` override that exits at once.
  [
    'Windows Git Bash, grok',
    {
      agent: 'grok',
      host: { remote: false, windows: true },
      cached: 'node',
      scanned: 'bash',
      shellAlone: false
    },
    bashRunsLaunchLineThatExits
  ],
  [
    'Windows WSL',
    { host: { remote: false, windows: true }, cached: 'claude', scanned: 'wsl', shellAlone: false },
    bashRunsLaunchLineThatExits
  ],
  // A pane under `login`, whose cached name is still the exited stub's.
  [
    'macOS zsh',
    {
      host: { remote: false, windows: false },
      cached: 'python3',
      scanned: 'zsh',
      rows: loginPane(101),
      shellAlone: false
    },
    zshRunsLaunchLineThatExits
  ]
]

function launchedPane(answers: HostAnswers) {
  paneTerminal.rows = answers.rows ?? null
  const listeners = new Set<(data: string) => void>()
  const subscribe = (_ptyId: string, listener: (data: string) => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const controller = {
    getForegroundProcess: async () => answers.cached,
    confirmForegroundProcess: async () => answers.scanned,
    confirmShellForeground: async () => answers.shellAlone,
    listProcesses: async () => [{ id: PTY_ID, rootProcessId: 100, cwd: '/repo', title: 'zsh' }]
  }
  const readForeground = (ptyId: string) =>
    readLaunchedAgentForeground(controller, answers.host, ptyId, answers.agent ?? 'claude')
  const writes: string[] = []
  const runtime = {
    waitForFreshWorkerComposer: async (
      _handle: string,
      agent: 'claude' | 'grok',
      timeoutMs: number
    ) => {
      const ptyId = await waitForWorktreeStartupDraft(
        {
          getPtyId: () => PTY_ID,
          getForegroundProcess: controller.getForegroundProcess,
          subscribeToData: subscribe,
          readRecentOutput: () => undefined,
          write: () => {}
        },
        'term-1',
        agent,
        {
          timeoutMs,
          requireComposerMarker: false,
          isShellInFront: async (id) => (await readForeground(id)) === 'shell'
        }
      )
      if (!ptyId) {
        throw new Error('timeout')
      }
      return { handle: 'term-1', satisfied: true, status: 'running' }
    },
    // The idle evidence after the budget: the shell's prompt can look settled too.
    waitForTerminal: vi.fn(async () => ({ handle: 'term-1', satisfied: true, status: 'idle' })),
    readLaunchedAgentForeground: (ptyId: string) => readForeground(ptyId),
    subscribeToTerminalData: subscribe,
    sendTerminalAgentPrompt: vi.fn(
      async (
        handle: string,
        text: string,
        options: { beforeWrite?: (id: string) => Promise<void> }
      ) => {
        await options.beforeWrite?.(PTY_ID)
        writes.push(text)
        return { handle, accepted: true, bytesWritten: text.length }
      }
    )
  }
  return {
    runtime,
    writes,
    emit: (data: string) => {
      for (const listener of listeners) {
        listener(data)
      }
    }
  }
}

describe('a launch prompt after the launched agent exits at startup', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each(HOSTS)(
    '%s: types nothing and reports it undelivered',
    async (_label, answers, transcript) => {
      const pane = launchedPane(answers)
      const delivery = deliverTerminalAgentLaunchPrompt({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the deliverer reaches only the methods built above.
        runtime: pane.runtime as unknown as Parameters<
          typeof deliverTerminalAgentLaunchPrompt
        >[0]['runtime'],
        handle: 'term-1',
        agent: answers.agent ?? 'claude',
        freshLaunch: true,
        text: 'QA prompt that must never run as a shell command'
      })
      for (const chunk of transcript()) {
        pane.emit(chunk)
      }
      await vi.advanceTimersByTimeAsync(61_000)

      await expect(delivery).resolves.toBe(false)
      expect(pane.writes).toEqual([])
    }
  )

  it('macOS zsh: still writes into an agent that stays up', async () => {
    const pane = launchedPane({
      host: { remote: false, windows: false },
      cached: 'claude',
      scanned: 'claude',
      rows: loginPane(200, [{ pid: 200, command: '/opt/bin/claude' }]),
      shellAlone: false
    })
    const delivery = deliverTerminalAgentLaunchPrompt({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the deliverer reaches only the methods built above.
      runtime: pane.runtime as unknown as Parameters<
        typeof deliverTerminalAgentLaunchPrompt
      >[0]['runtime'],
      handle: 'term-1',
      agent: 'claude',
      freshLaunch: true,
      text: 'QA prompt'
    })
    pane.emit(zshRunsLaunchLineThatExits()[0])
    pane.emit('\x1b[?2004hClaude Code\r\n> ')
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(delivery).resolves.toBe(true)
    expect(pane.writes).toEqual(['QA prompt'])
  })
})
