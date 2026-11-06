import { describe, expect, it, vi } from 'vitest'
import { EVERY_AGENT_CHAT } from '../../shared/native-chat/every-agent-chat.test-fixture'
import { launchHeadlessAutomationAgent } from './headless-automation-agent-launch'
import { AutomationRunLaunchError } from './headless-dispatch'

function runtimeDelivering(deliverStartupFollowup: () => Promise<boolean>) {
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

describe('headless automation agent launch', () => {
  it.each([
    ['is refused', async () => false],
    [
      'throws',
      async () => {
        throw new Error('writer broke')
      }
    ]
  ])('fails the run and keeps its terminal when prompt delivery %s', async (_, deliver) => {
    const failure = await launchHeadlessAutomationAgent(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the existing-workspace launch reads only these runtime members.
      runtimeDelivering(deliver) as never,
      {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only these automation fields are read.
        automation: {
          id: 'auto-1',
          agentId: 'aider',
          prompt: 'fix the flaky test',
          workspaceMode: 'existing',
          workspaceId: 'wt-1'
        } as never,
        run: { id: 'run-1', title: 'Nightly', scheduledFor: 1, trigger: 'scheduled' },
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the repo is read.
        target: { ok: true, repo: { id: 'repo-1', path: '/repo', displayName: 'repo' } } as never,
        runs: []
      }
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AutomationRunLaunchError)
    expect(failure).toMatchObject({
      target: { terminalHandle: 'term-1', terminalPaneKey: 'tab-1:leaf-1', terminalPtyId: 'pty-1' }
    })
  })
})
