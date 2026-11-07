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
