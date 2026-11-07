import { describe, expect, it, vi } from 'vitest'
import { EVERY_AGENT_CHAT } from '../../shared/native-chat/every-agent-chat.test-fixture'
import type { GeneratedInputOutcome } from '../../shared/generated-terminal-input'
import { launchAutomationTerminalAgent } from './automation-terminal-launch'
import { AutomationDispatchRefusedError } from './automation-launch-runner'

const { deliverTerminalAgentLaunchPrompt } = vi.hoisted(() => ({
  deliverTerminalAgentLaunchPrompt: vi.fn(
    async (_args: { onOutcome?: (outcome: GeneratedInputOutcome) => void }) => true
  )
}))
vi.mock('../runtime/rpc/methods/agent-launch/agent-launch-terminal-prompt', () => ({
  deliverTerminalAgentLaunchPrompt
}))

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
    getPtyExecutionHostMetadata: vi.fn(() => ({ executionHostId: 'local' })),
    deliverStartupFollowup: vi.fn(deliverStartupFollowup)
  }
}

function launch(runtime: ReturnType<typeof fakeRuntime>, reuseSession = false) {
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
        reuseSession
      } as never,
      run: { id: 'run-1', title: 'Nightly', scheduledFor: 1, trigger: 'scheduled' },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the repo is read.
      target: { ok: true, repo: { id: 'repo-1', path: '/repo', displayName: 'repo' } } as never,
      runs: []
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

      const failure = await launch(runtime, true).catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(AutomationDispatchRefusedError)
      expect(failure).toMatchObject({ failure: { errorCode: 'targetUnavailable' } })
      expect(runtime.launchAgentTerminal).not.toHaveBeenCalled()
      expect(runtime.deliverStartupFollowup).not.toHaveBeenCalled()
    }
  )
})

// F5: a reused session's prompt may fall through to a fresh terminal only when that session was
// gone before anything was written; otherwise the run fails rather than send the prompt twice.
function relaunch(outcome: GeneratedInputOutcome) {
  deliverTerminalAgentLaunchPrompt.mockImplementation(async (args) => {
    args.onOutcome?.(outcome)
    return false
  })
  const runtime = {
    requireStore: () => ({ getSettings: () => ({ nativeChatProviders: EVERY_AGENT_CHAT }) }),
    resolveManagedTerminalWorkspaceTarget: vi.fn(async () => ({
      managedWorktree: { displayName: 'repo' },
      scope: { folderWorkspace: null }
    })),
    getAgentStatusRowsForPane: () => [{ state: 'done', agentType: 'claude', receivedAt: 2 }],
    getTerminalHandleForPaneKey: (paneKey: string) =>
      paneKey === 'tab-prev:leaf-1' ? 'term_prev' : null,
    getTerminalPtyIdForHandle: () => 'pty-prev',
    getTerminalWorktreeIdForHandle: () => 'wt-1',
    getPtyExecutionHostMetadata: () => ({ executionHostId: 'local' }),
    launchAgentTerminal: vi.fn(async () => ({
      handle: 'term_existing',
      tabId: 'tab-1',
      paneKey: 'tab-1:leaf-1',
      ptyId: 'pty-1',
      worktreeId: 'wt-1',
      title: 'Nightly'
    })),
    deliverStartupFollowup: vi.fn(async () => true)
  }
  const launched = launchAutomationTerminalAgent(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reused-session launch reads only these runtime members.
    runtime as never,
    {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only these automation fields are read.
      automation: {
        id: 'auto-1',
        agentId: 'claude',
        prompt: 'fix the flaky test',
        workspaceMode: 'existing',
        workspaceId: 'wt-1',
        reuseSession: true
      } as never,
      run: { id: 'run-1', title: 'Nightly', scheduledFor: 2, trigger: 'scheduled' },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the repo is read.
      target: { ok: true, repo: { id: 'repo-1', path: '/repo', displayName: 'repo' } } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the previous run's workspace and terminal fields are read.
      runs: [
        {
          id: 'run-0',
          automationId: 'auto-1',
          status: 'completed',
          trigger: 'scheduled',
          workspaceId: 'wt-1',
          sessionKind: 'terminal',
          terminalSessionId: 'tab-prev',
          terminalPaneKey: 'tab-prev:leaf-1',
          terminalPtyId: 'pty-prev',
          startedAt: 1,
          createdAt: 1
        }
      ] as never
    }
  )
  return { runtime, launched }
}

describe('a reused automation session', () => {
  it('launches fresh only when the reused terminal was gone before any write', async () => {
    const { runtime, launched } = relaunch('target-gone')
    await expect(launched).resolves.toMatchObject({ terminalHandle: 'term_existing' })
    expect(runtime.launchAgentTerminal).toHaveBeenCalledTimes(1)
  })

  it.each(['not-sent', 'unconfirmed'] as const)(
    'fails the run instead of sending the prompt to a second session when it was %s',
    async (outcome) => {
      const { runtime, launched } = relaunch(outcome)
      await expect(launched).rejects.toThrow(/Claude/)
      expect(runtime.launchAgentTerminal).not.toHaveBeenCalled()
    }
  )
})
