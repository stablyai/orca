import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { AGENT_PROMPT_TEST_WORKTREE_PATH } from './agent-prompt-submission-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import type * as TerminalForegroundGroup from './terminal-foreground-group'

const { WORKTREE } = vi.hoisted(() => ({
  WORKTREE: {
    path: '/tmp/worktree-a',
    head: 'abc',
    branch: 'feature/launch-turn-start',
    isBare: false,
    isMainWorktree: false
  }
}))

// What `ps` limited to the pane's terminal answers: a login-wrapped zsh whose terminal's foreground
// group is the shell itself, or the named process launched from it. The verdict stays the real one.
const paneForeground = vi.hoisted(() => {
  const state: { command: string | null } = { command: null }
  return state
})
vi.mock('./terminal-foreground-group', async (importOriginal) => ({
  ...(await importOriginal<typeof TerminalForegroundGroup>()),
  readTerminalProcessRows: vi.fn(async (): Promise<ProcessTableRow[] | null> => {
    const command = paneForeground.command
    if (command === null) {
      return null
    }
    const group = command === 'zsh' ? 101 : 102
    return [
      { pid: 100, ppid: 1, pgid: 100, tpgid: group, stat: 'Ss', command: '/usr/bin/login -flpq u' },
      { pid: 101, ppid: 100, pgid: 101, tpgid: group, stat: 'S', command: '-zsh' },
      ...(command === 'zsh'
        ? []
        : [{ pid: 102, ppid: 101, pgid: 102, tpgid: group, stat: 'S+', command }])
    ]
  })
}))

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([WORKTREE]),
  listWorktreesStrict: vi.fn().mockResolvedValue([WORKTREE])
}))

async function launchedCodex(
  rows: () => AgentStatusIpcPayload[],
  options: { hooksEnabled?: boolean; foreground?: () => string | null } = {}
) {
  const store = makeStore()
  const settings = { ...store.getSettings(), agentStatusHooksEnabled: options.hooksEnabled ?? true }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared store fixture implements only what a launch reads.
  const launchStore = { ...store, getSettings: () => settings } as never
  const runtime = new OrcaRuntimeService(launchStore, undefined, { getAgentStatusSnapshot: rows })
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'pty-launch' }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => [
      { id: 'pty-launch', rootProcessId: 100, cwd: '/tmp/worktree-a', title: 'zsh' }
    ]
  })
  paneForeground.command = options.foreground?.() ?? null
  const { handle } = await runtime.createTerminal(`path:${AGENT_PROMPT_TEST_WORKTREE_PATH}`, {
    launchAgent: 'codex'
  })
  return { runtime, handle }
}

function workingRow(
  handle: string,
  at: number,
  explicitPromptStartedAt?: number
): AgentStatusIpcPayload {
  return {
    paneKey: 'launch-pane',
    terminalHandle: handle,
    state: 'working',
    prompt: 'the brief',
    agentType: 'codex',
    connectionId: null,
    receivedAt: at,
    stateStartedAt: at,
    ...(explicitPromptStartedAt !== undefined ? { explicitPromptStartedAt } : {})
  }
}

describe('observeTerminalLaunchTurnStart', () => {
  it('reads a Codex spinner title with no prompt hook as unobserved', async () => {
    const { runtime, handle } = await launchedCodex(() => [])
    const launchStartedAt = Date.now()
    runtime.onPtyData('pty-launch', '\x1b]0;Codex working\x07', Date.now())

    await expect(
      runtime.observeTerminalLaunchTurnStart(handle, { launchStartedAt, agent: 'codex' }, 300)
    ).resolves.toBe('unobserved')
  })

  it('reads a hook turn that carried no prompt as unobserved', async () => {
    let rows: AgentStatusIpcPayload[] = []
    const { runtime, handle } = await launchedCodex(() => rows)
    const launchStartedAt = Date.now() - 10
    rows = [workingRow(handle, Date.now())]

    await expect(
      runtime.observeTerminalLaunchTurnStart(handle, { launchStartedAt, agent: 'codex' }, 300)
    ).resolves.toBe('unobserved')
  })

  it('observes a prompt-carrying hook turn after the launch', async () => {
    let rows: AgentStatusIpcPayload[] = []
    const { runtime, handle } = await launchedCodex(() => rows)
    const launchStartedAt = Date.now() - 10
    rows = [workingRow(handle, Date.now(), Date.now())]

    await expect(
      runtime.observeTerminalLaunchTurnStart(handle, { launchStartedAt, agent: 'codex' }, 300)
    ).resolves.toBe('observed')
  })

  // Why: with hooks off, main's evidence decides, so a worker start is no slower than main's.
  it('takes a title turn-start edge as the turn when hooks are turned off', async () => {
    const { runtime, handle } = await launchedCodex(() => [], { hooksEnabled: false })
    const observed = runtime.observeTerminalLaunchTurnStart(
      handle,
      { launchStartedAt: Date.now(), agent: 'codex' },
      2_000
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    runtime.onPtyData('pty-launch', '\x1b]0;Codex working\x07', Date.now())

    await expect(observed).resolves.toBe('observed')
  })

  // A Windows host cannot prove an agent in front; its shell alone is all it reads.
  it.skipIf(process.platform === 'win32')(
    'takes an agent proven in front as the launch when its hooks give no proof',
    async () => {
      const { runtime, handle } = await launchedCodex(() => [], { foreground: () => 'aider' })

      await expect(
        runtime.observeTerminalLaunchTurnStart(
          handle,
          { launchStartedAt: Date.now(), agent: 'aider' },
          2_000
        )
      ).resolves.toBe('unsupported')
    }
  )

  // Why: Claude's hook is its usual proof; with hooks turned off it must not wait out the silence.
  it.skipIf(process.platform === 'win32')(
    'judges a Claude launch at once when hooks are turned off',
    async () => {
      const { runtime, handle } = await launchedCodex(() => [], {
        hooksEnabled: false,
        foreground: () => 'claude'
      })
      const startedAt = Date.now()

      await expect(
        runtime.observeTerminalLaunchTurnStart(
          handle,
          { launchStartedAt: startedAt, agent: 'claude' },
          5_000
        )
      ).resolves.toBe('unsupported')
      expect(Date.now() - startedAt).toBeLessThan(1_000)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'reports a launch the shell finished, with the shell back in front, as exited',
    async () => {
      const { runtime, handle } = await launchedCodex(() => [], { foreground: () => 'zsh' })
      const observed = runtime.observeTerminalLaunchTurnStart(
        handle,
        { launchStartedAt: Date.now(), agent: 'codex' },
        2_000
      )
      await new Promise((resolve) => setTimeout(resolve, 300))
      runtime.emitDaemonPtyTransientFact('pty-launch', { kind: 'command-finished', exitCode: 1 })

      await expect(observed).resolves.toBe('exited')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'does not read a finished command as an exit while the agent still holds the terminal',
    async () => {
      const { runtime, handle } = await launchedCodex(() => [], { foreground: () => 'codex' })
      const observed = runtime.observeTerminalLaunchTurnStart(
        handle,
        { launchStartedAt: Date.now(), agent: 'codex' },
        800
      )
      await new Promise((resolve) => setTimeout(resolve, 300))
      runtime.emitDaemonPtyTransientFact('pty-launch', { kind: 'command-finished', exitCode: 0 })

      await expect(observed).resolves.toBe('unobserved')
    }
  )
})
