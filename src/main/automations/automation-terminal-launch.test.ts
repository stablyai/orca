import { describe, expect, it, vi } from 'vitest'
import { EVERY_AGENT_CHAT } from '../../shared/native-chat/every-agent-chat.test-fixture'
import { launchAutomationTerminalAgent } from './automation-terminal-launch'
import { AutomationDispatchRefusedError } from './automation-launch-runner'

function fakeRuntime(deliverStartupFollowup: () => Promise<boolean>) {
  return {
    requireStore: () => ({ getSettings: () => ({ nativeChatProviders: EVERY_AGENT_CHAT }) }),
    resolveManagedTerminalWorkspaceTarget: vi.fn(async () => ({
      managedWorktree: { displayName: 'repo' },
      scope: { folderWorkspace: null }
    })),
    launchAgentTerminal: vi.fn(async () => ({
      handle: 'term-1',
      tabId: 'tab-1',
      paneKey: 'tab-1:leaf-1',
      ptyId: 'pty-1',
      worktreeId: 'wt-1',
      title: 'Nightly'
    })),
    getAgentStatusRowsForPane: vi.fn(() => []),
    getTerminalHandleForPaneKey: vi.fn(() => 'term-1'),
    getTerminalPtyIdForHandle: vi.fn(() => 'pty-1'),
    getTerminalWorktreeIdForHandle: vi.fn(() => 'wt-1'),
    getPtyExecutionHostMetadata: vi.fn(() => ({ executionHostId: 'local' })),
    deliverStartupFollowup: vi.fn(deliverStartupFollowup)
  }
}

function previousRun(status: 'completed' | 'dispatched') {
  return {
    id: 'run-previous',
    automationId: 'auto-1',
    workspaceId: 'wt-1',
    status,
    terminalSessionId: 'tab-1',
    terminalPaneKey: 'tab-1:leaf-1',
    terminalPtyId: 'pty-1',
    createdAt: 1,
    startedAt: 1,
    dispatchedAt: 1
  }
}

function launch(
  runtime: ReturnType<typeof fakeRuntime>,
  options: {
    reuseSession?: boolean
    onNoReusableSession?: 'skip'
    runs?: ReturnType<typeof previousRun>[]
  } = {}
) {
  return launchAutomationTerminalAgent(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the existing-workspace launch reads only these runtime members.
    runtime as never,
    {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only these automation fields are read.
      automation: {
        id: 'auto-1',
        agentId: 'aider',
        prompt: 'fix the flaky test',
        workspaceMode: 'existing',
        workspaceId: 'wt-1',
        reuseSession: options.reuseSession ?? false,
        ...(options.onNoReusableSession ? { onNoReusableSession: options.onNoReusableSession } : {})
      } as never,
      run: { id: 'run-1', title: 'Nightly', scheduledFor: 1, trigger: 'scheduled' },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the repo is read.
      target: { ok: true, repo: { id: 'repo-1', path: '/repo', displayName: 'repo' } } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the selector reads only pane, status, and recency fields.
      runs: (options.runs ?? []) as never
    }
  )
}

describe('headless automation agent launch', () => {
  it.each([
    ['resolves on a paired server', { hostId: 'runtime:env-1' }, null],
    ['is gone', null, new Error('selector_not_found')]
  ])(
    'refuses, without launching, a reused-session run whose workspace %s',
    async (_, workspace, resolveError) => {
      const runtime = fakeRuntime(async () => true)
      runtime.resolveManagedTerminalWorkspaceTarget.mockImplementation(async () => {
        if (resolveError) {
          throw resolveError
        }
        return {
          managedWorktree: { displayName: 'repo', ...workspace },
          scope: { folderWorkspace: null }
        }
      })

      const failure = await launch(runtime, { reuseSession: true }).catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(AutomationDispatchRefusedError)
      expect(failure).toMatchObject({ failure: { errorCode: 'targetUnavailable' } })
      expect(runtime.launchAgentTerminal).not.toHaveBeenCalled()
      expect(runtime.deliverStartupFollowup).not.toHaveBeenCalled()
    }
  )
})

describe('strict reuse-session launch', () => {
  it.each([
    ['still working', 'completed', 'sessionBusy'],
    ['unable to take the run', 'dispatched', 'sessionNotReusable']
  ])(
    'skips, without launching a second session, a run whose previous session is %s',
    async (_, status, errorCode) => {
      const runtime = fakeRuntime(async () => true)
      runtime.getAgentStatusRowsForPane.mockReturnValue([
        { state: status === 'completed' ? 'working' : 'done', agentType: 'aider', receivedAt: 1 }
      ])

      const failure = await launch(runtime, {
        reuseSession: true,
        onNoReusableSession: 'skip',
        runs: [previousRun(status as 'completed' | 'dispatched')]
      }).catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(AutomationDispatchRefusedError)
      expect(failure).toMatchObject({ failure: { errorCode } })
      expect(runtime.launchAgentTerminal).not.toHaveBeenCalled()
    }
  )

  it('still launches a first session when the previous pane is gone', async () => {
    const runtime = fakeRuntime(async () => true)
    runtime.getTerminalHandleForPaneKey.mockReturnValue(null)

    await expect(
      launch(runtime, {
        reuseSession: true,
        onNoReusableSession: 'skip',
        runs: [previousRun('completed')]
      })
    ).resolves.toMatchObject({ terminalHandle: 'term-1' })
    expect(runtime.launchAgentTerminal).toHaveBeenCalledTimes(1)
  })

  it('keeps the fresh fallback when the automation does not ask to skip', async () => {
    const runtime = fakeRuntime(async () => true)
    runtime.getAgentStatusRowsForPane.mockReturnValue([
      { state: 'working', agentType: 'aider', receivedAt: 1 }
    ])

    await expect(
      launch(runtime, { reuseSession: true, runs: [previousRun('completed')] })
    ).resolves.toMatchObject({ terminalHandle: 'term-1' })
    expect(runtime.launchAgentTerminal).toHaveBeenCalledTimes(1)
  })
})
