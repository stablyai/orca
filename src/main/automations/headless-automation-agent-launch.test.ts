import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  runtimeStub,
  setAgentLaunchRecordStore
} from '../runtime/rpc/methods/agent-launch.test-fixture'
import { openTestAgentSessionRecordStore } from '../runtime/agent-session/records/agent-session-record-store-test-harness'
import { closeTestJournalHostDatabases } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { EVERY_AGENT_CHAT } from '../../shared/native-chat/every-agent-chat.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { AutomationRun } from '../../shared/automations-types'
import type { RuntimeTerminalCreate } from '../../shared/runtime-terminal-create-contract'
import { launchHeadlessAutomationAgent } from './headless-automation-agent-launch'

const { deliverTerminalAgentLaunchPrompt } = vi.hoisted(() => ({
  deliverTerminalAgentLaunchPrompt: vi.fn(async (_args: Record<string, unknown>) => true)
}))
vi.mock('../runtime/rpc/methods/agent-launch-terminal-prompt', () => ({
  deliverTerminalAgentLaunchPrompt
}))

let ledgerDirectory: string
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.UTC(2026, 10, 3))
  ledgerDirectory = mkdtempSync(join(tmpdir(), 'orca-33492-merge-'))
  setAgentLaunchRecordStore(await openTestAgentSessionRecordStore(ledgerDirectory))
  deliverTerminalAgentLaunchPrompt.mockClear()
  deliverTerminalAgentLaunchPrompt.mockResolvedValue(true)
})

afterEach(async () => {
  vi.useRealTimers()
  setAgentLaunchRecordStore(null)
  await closeTestJournalHostDatabases()
  rmSync(ledgerDirectory, { recursive: true, force: true })
})

const CHAT_DEFAULT_ON = { nativeChatProviders: EVERY_AGENT_CHAT }

function harness(
  options: {
    startupTerminal?: Record<string, unknown> | null
    workspaceHostId?: ExecutionHostId
  } = {}
) {
  const startupTerminalCreation: RuntimeTerminalCreate = {
    handle: 'term_new',
    tabId: 'tab-new',
    paneKey: 'tab-new:leaf-1',
    ptyId: 'pty-new',
    worktreeId: 'repo-1::/wt/auto',
    title: 'auto-nightly'
  }
  const host = runtimeStub()
  const runtime = {
    ...host,
    startupTerminalCreation,
    requireStore: () => ({ getSettings: () => CHAT_DEFAULT_ON }),
    getStructuredAgentSessionCreateSupport: vi.fn(async () => ({ supported: true })),
    createManagedWorktree: vi.fn(
      async (
        args: Record<string, unknown> & {
          onStartupTerminalCreated?: (terminal: RuntimeTerminalCreate) => void
        }
      ) => {
        if (options.startupTerminal !== null) {
          args.onStartupTerminalCreated?.(startupTerminalCreation)
        }
        return {
          worktree: { id: 'repo-1::/wt/auto', displayName: 'auto-nightly' },
          ...(options.startupTerminal === null
            ? { warning: 'Startup terminal failed.' }
            : { startupTerminal: options.startupTerminal ?? startupTerminalCreation })
        }
      }
    ),
    launchAgentTerminal: vi.fn(async (_selector: string, _opts: Record<string, unknown>) => ({
      handle: 'term_existing',
      tabId: 'tab-1',
      paneKey: 'tab-1:leaf-1',
      ptyId: 'pty-1',
      worktreeId: 'wt-1',
      title: 'Nightly',
      suppressStartupUpdatePrompt: true
    })),
    resolveManagedTerminalWorkspaceTarget: vi.fn(async (selector: string) => ({
      managedWorktree: {
        displayName: 'repo',
        ...(options.workspaceHostId ? { hostId: options.workspaceHostId } : {})
      },
      scope: await host.showTerminalWorkspaceLaunchScope(selector)
    })),
    getAgentStatusRowsForPane: vi.fn((_paneKey: string) => [
      { state: 'done', agentType: 'claude', receivedAt: 2 }
    ]),
    getTerminalHandleForPaneKey: vi.fn((paneKey: string) =>
      paneKey === 'tab-prev:leaf-1' ? 'term_prev' : null
    ),
    getTerminalPtyIdForHandle: vi.fn((_handle: string) => 'pty-prev'),
    getTerminalWorktreeIdForHandle: vi.fn((_handle: string) => 'wt-1'),
    getPtyExecutionHostMetadata: vi.fn(
      (_ptyId: string | null): { executionHostId: ExecutionHostId } => ({
        executionHostId: 'local'
      })
    ),
    deliverStartupFollowup: vi.fn(
      async (_handle: string, _followup: { agent: string; prompt: string }) => true
    )
  }
  host.showTerminal.mockImplementation(async (handle) => ({
    handle,
    worktreeId: runtime.getTerminalWorktreeIdForHandle(handle)
  }))
  host.showTerminalWorkspaceLaunchScope.mockImplementation(async (selector) => ({
    id: selector.replace(/^id:/, ''),
    path: '/repo',
    connectionId: options.workspaceHostId?.startsWith('ssh:')
      ? options.workspaceHostId.slice(4)
      : null,
    repo: null,
    folderWorkspace: null
  }))
  host.createTerminal.mockImplementation(async () => runtime.launchAgentTerminal('id:wt-1', {}))
  return runtime
}

function automation(overrides: Record<string, unknown>) {
  return {
    id: 'auto-1',
    agentId: 'claude',
    prompt: '  fix the flaky test  ',
    workspaceMode: 'existing',
    workspaceId: 'wt-1',
    ...overrides
  }
}

const RUN = {
  id: 'run-1',
  title: 'Nightly',
  createdAt: Date.UTC(2026, 10, 3),
  scheduledFor: Date.UTC(2026, 9, 9, 3),
  trigger: 'scheduled' as const
}
const TARGET = { ok: true, repo: { id: 'repo-1', path: '/repo', displayName: 'repo' } }

function previousRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-0',
    automationId: 'auto-1',
    title: 'Nightly',
    scheduledFor: 1,
    status: 'completed',
    trigger: 'scheduled',
    workspaceId: 'wt-1',
    workspaceDisplayName: 'repo',
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: 'tab-prev',
    terminalPaneKey: 'tab-prev:leaf-1',
    terminalPtyId: 'pty-prev',
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: 1,
    dispatchedAt: 1,
    createdAt: 1,
    ...overrides
  }
}

function launch(
  runtime: ReturnType<typeof harness>,
  overrides: Record<string, unknown>,
  runs: AutomationRun[] = [],
  run: typeof RUN | (Omit<typeof RUN, 'trigger'> & { trigger: 'manual' }) = RUN
) {
  return launchHeadlessAutomationAgent(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch reads only the members faked in harness().
    runtime as never,
    {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only these automation fields are read.
      automation: automation(overrides) as never,
      run,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the repo is read.
      target: TARGET as never,
      runs
    }
  )
}

describe('headless automation agent launch', () => {
  // E9: the runtime holds a background start on a stopped WSL distro; only Run now names the user.
  it("starts Run now as the user's act, and a scheduled run as background work", async () => {
    const scheduled = harness()
    await launch(scheduled, {})
    expect(scheduled.launchAgentTerminal.mock.calls[0]?.[1]).not.toHaveProperty('wslUserAct')

    const manual = harness()
    await launch(manual, {}, [], { ...RUN, trigger: 'manual' })
    expect(manual.launchAgentTerminal).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({ wslUserAct: true }),
      { worktree: { displayName: 'repo' }, repo: TARGET.repo }
    )
  })

  it('admits the selected workspace before writing, and vetoes historical or live host conflicts', async () => {
    const runtime = harness()
    const oldTarget = {
      kind: 'workspace-run',
      projectId: 'old-project',
      projectHostSetupId: 'old-setup',
      hostId: 'ssh:old',
      repoId: 'repo-1',
      path: '/repo'
    } as const
    await launch(runtime, { reuseSession: true }, [previousRun({ runContext: oldTarget })])
    expect(deliverTerminalAgentLaunchPrompt).not.toHaveBeenCalled()
    expect(runtime.launchAgentTerminal).toHaveBeenCalledTimes(1)
    runtime.launchAgentTerminal.mockClear()
    runtime.getPtyExecutionHostMetadata.mockReturnValue({ executionHostId: 'ssh:old' })
    await launch(runtime, { reuseSession: true }, [previousRun()], {
      ...RUN,
      id: 'live-host-conflict'
    })
    expect(deliverTerminalAgentLaunchPrompt).not.toHaveBeenCalled()
    expect(runtime.launchAgentTerminal).toHaveBeenCalledTimes(1)
    runtime.launchAgentTerminal.mockClear()
    runtime.resolveManagedTerminalWorkspaceTarget.mockRejectedValueOnce(
      new Error('selector_not_found')
    )
    await expect(launch(runtime, { reuseSession: true }, [previousRun()])).rejects.toThrow(
      'could not confirm'
    )
    expect(deliverTerminalAgentLaunchPrompt).not.toHaveBeenCalled()
    expect(runtime.launchAgentTerminal).not.toHaveBeenCalled()
  })

  it('reuses a proven local legacy pane and ignores logical setup replacement for the same physical target', async () => {
    const runtime = harness()
    for (const [index, runContext] of [
      undefined,
      {
        kind: 'workspace-run',
        projectId: 'replaced-project',
        projectHostSetupId: 'replaced-setup',
        hostId: 'local',
        repoId: 'repo-1',
        path: '/repo/'
      } as const
    ].entries()) {
      await launch(runtime, { reuseSession: true }, [previousRun({ runContext })], {
        ...RUN,
        id: `run-${index + 1}`
      })
    }
    expect(deliverTerminalAgentLaunchPrompt).toHaveBeenCalledTimes(2)
    expect(runtime.launchAgentTerminal).not.toHaveBeenCalled()
    expect(runtime.resolveManagedTerminalWorkspaceTarget.mock.calls).toEqual(
      Array.from({ length: 2 }, () => [
        ['id:wt-1', 'local', false],
        ['id:wt-1', undefined, false]
      ]).flat()
    )
  })

  it('reuses a pinned SSH folder with local project history without fresh transport acquisition', async () => {
    const runtime = harness({ workspaceHostId: 'ssh:prod' })
    runtime.getTerminalWorktreeIdForHandle.mockReturnValue('folder:fw-1')
    runtime.getPtyExecutionHostMetadata.mockReturnValue({ executionHostId: 'ssh:prod' })
    const runContext = {
      kind: 'workspace-run',
      projectId: 'project',
      projectHostSetupId: 'setup',
      hostId: 'local',
      repoId: 'repo-1',
      path: '/repo'
    } as const
    const result = await launch(
      runtime,
      { workspaceId: 'folder:fw-1', reuseSession: true, runContext },
      [previousRun({ workspaceId: 'folder:fw-1', runContext })]
    )
    expect(runtime.resolveManagedTerminalWorkspaceTarget).toHaveBeenCalledWith(
      'id:folder:fw-1',
      undefined,
      false
    )
    expect(deliverTerminalAgentLaunchPrompt).toHaveBeenCalledOnce()
    expect(runtime.launchAgentTerminal).not.toHaveBeenCalled()
    expect(result.terminalHandle).toBe('term_prev')
  })

  it('launches Hermes through the ordinary agent contract', async () => {
    const runtime = harness()

    const launched = await launch(runtime, { agentId: 'hermes' })

    expect(runtime.launchAgentTerminal).toHaveBeenCalledWith(
      'id:wt-1',
      {
        agent: 'hermes',
        prompt: 'fix the flaky test',
        title: 'Nightly',
        suppressStartupUpdatePrompt: true
      },
      { worktree: { displayName: 'repo' }, repo: TARGET.repo }
    )
    expect(runtime.deliverStartupFollowup).not.toHaveBeenCalled()
    expect(launched.terminalHandle).toBe('term_existing')
  })

  it('starts an argv agent in an existing workspace with the prompt on its command', async () => {
    const runtime = harness()

    const launched = await launch(runtime, { extraAgentArgs: '--model opus' })

    expect(runtime.launchAgentTerminal).toHaveBeenCalledWith(
      'id:wt-1',
      {
        agent: 'claude',
        prompt: 'fix the flaky test',
        title: 'Nightly',
        suppressStartupUpdatePrompt: true,
        extraAgentArgs: '--model opus'
      },
      { worktree: { displayName: 'repo' }, repo: TARGET.repo }
    )
    expect(runtime.deliverStartupFollowup).not.toHaveBeenCalled()
    expect(runtime.getStructuredAgentSessionCreateSupport).not.toHaveBeenCalled()
    expect(launched).toEqual({
      workspaceId: 'wt-1',
      workspaceDisplayName: 'repo',
      terminalHandle: 'term_existing',
      terminalSessionId: 'tab-1',
      terminalPaneKey: 'tab-1:leaf-1',
      terminalPtyId: 'pty-1'
    })
  })

  it.each(['existing', 'new_per_run'] as const)(
    'carries canonical full setup on the %s fresh path',
    async (workspaceMode) => {
      const runtime = harness()
      await launch(runtime, {
        workspaceMode,
        agentArgs: null,
        launchPreferences: { options: { fastMode: 'true' } }
      })
      if (workspaceMode === 'existing') {
        expect(runtime.launchAgentTerminal).toHaveBeenCalledWith(
          'id:wt-1',
          expect.objectContaining({ agentArgs: null, sessionOptions: { fastMode: 'true' } }),
          expect.anything()
        )
      } else {
        expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
          expect.objectContaining({
            startupAgentArgs: null,
            startupSessionOptions: { fastMode: 'true' }
          })
        )
      }
    }
  )

  it('starts a post-start agent bare and delivers its prompt once, after the terminal is recorded', async () => {
    const runtime = harness()
    let finishDelivery: (delivered: boolean) => void = () => {}
    runtime.deliverStartupFollowup.mockImplementation(
      () => new Promise<boolean>((resolve) => (finishDelivery = resolve))
    )

    const launched = await launch(runtime, { agentId: 'aider' })

    expect(launched.terminalPaneKey).toBe('tab-1:leaf-1')
    expect(runtime.launchAgentTerminal).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({ agent: 'aider', prompt: '' }),
      { worktree: { displayName: 'repo' }, repo: TARGET.repo }
    )
    expect(runtime.deliverStartupFollowup).toHaveBeenCalledTimes(1)
    expect(runtime.deliverStartupFollowup).toHaveBeenCalledWith(
      'term_existing',
      {
        agent: 'aider',
        prompt: 'fix the flaky test'
      },
      { terminalCreation: await runtime.launchAgentTerminal.mock.results[0].value }
    )
    finishDelivery(true)
  })

  it('creates a new-per-run workspace agent-first with the argv prompt', async () => {
    const runtime = harness()

    const launched = await launch(runtime, {
      workspaceMode: 'new_per_run',
      workspaceId: null,
      extraAgentArgs: '--model opus'
    })

    expect(runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
    const args = runtime.createManagedWorktree.mock.calls[0]![0]
    expect(args).toMatchObject({
      repoSelector: { selector: 'id:repo-1', hostId: 'local' },
      activate: false,
      setupDecision: 'skip',
      startupAgent: 'claude',
      startupPrompt: 'fix the flaky test',
      startupExtraAgentArgs: '--model opus',
      createdWithAgent: 'claude',
      telemetrySource: 'unknown'
    })
    expect(args).not.toHaveProperty('awaitTerminalProvisioning')
    expect(args).not.toHaveProperty('observeSetupCompletion')
    expect(runtime.launchAgentTerminal).not.toHaveBeenCalled()
    expect(runtime.deliverStartupFollowup).not.toHaveBeenCalled()
    expect(launched).toEqual({
      workspaceId: 'repo-1::/wt/auto',
      workspaceDisplayName: 'auto-nightly',
      terminalHandle: 'term_new',
      terminalSessionId: 'tab-new',
      terminalPaneKey: 'tab-new:leaf-1',
      terminalPtyId: 'pty-new'
    })
  })

  it('creates a new-per-run workspace for a post-start agent and delivers its prompt once', async () => {
    const runtime = harness()

    await launch(runtime, { agentId: 'goose', workspaceMode: 'new_per_run', workspaceId: null })

    expect(runtime.createManagedWorktree.mock.calls[0]![0]).not.toHaveProperty('startupPrompt')
    expect(runtime.deliverStartupFollowup).toHaveBeenCalledTimes(1)
    expect(runtime.deliverStartupFollowup).toHaveBeenCalledWith(
      'term_new',
      { agent: 'goose', prompt: 'fix the flaky test' },
      { terminalCreation: runtime.startupTerminalCreation }
    )
  })

  it('fails the run with the create warning when no agent terminal started, without a second one', async () => {
    const runtime = harness({ startupTerminal: null })

    await expect(
      launch(runtime, { workspaceMode: 'new_per_run', workspaceId: null })
    ).rejects.toThrow('Startup terminal failed.')
    expect(runtime.launchAgentTerminal).not.toHaveBeenCalled()
  })

  it('launches bare and delivers nothing for a blank prompt', async () => {
    const runtime = harness()

    await launch(runtime, { agentId: 'aider', prompt: '   ' })

    expect(runtime.launchAgentTerminal).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({ prompt: '' }),
      { worktree: { displayName: 'repo' }, repo: TARGET.repo }
    )
    expect(runtime.deliverStartupFollowup).not.toHaveBeenCalled()
  })

  it('logs a failure after the terminal was recorded instead of dropping it', async () => {
    const runtime = harness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    runtime.deliverStartupFollowup.mockRejectedValue(new Error('writer broke'))

    const launched = await launch(runtime, { agentId: 'aider' })
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('after its terminal was published'),
        expect.objectContaining({ message: 'writer broke' })
      )
    )

    expect(launched.terminalHandle).toBe('term_existing')
    warn.mockRestore()
  })

  it('refuses an existing-workspace run whose workspace is gone', async () => {
    const runtime = harness()

    await expect(launch(runtime, { workspaceId: null })).rejects.toThrow(
      'The target workspace is no longer available.'
    )
    expect(runtime.launchAgentTerminal).not.toHaveBeenCalled()
  })
})
