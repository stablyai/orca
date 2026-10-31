import { expect, it, vi } from 'vitest'
import { buildProfileStateCutoverFixture } from '../persistence/profile-state-cutover-fixture'
import { launchAutomationChatAgent } from './automation-chat-agent-launch'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

const launch = vi.hoisted(() => vi.fn())
vi.mock('../runtime/rpc/methods/agent-launch', () => ({ launchAgentOnHost: launch }))
vi.mock('./automation-agent-run-result', () => ({
  publishedLaunchTarget: () => ({}),
  enrichAutomationRunTarget: (_runtime: unknown, result: unknown) => result
}))

it.each(['run', 'skip', undefined] as const)(
  'forwards saved %s to Chat creation without a new Ask or inherited default',
  async (setupDecision) => {
    launch.mockReset().mockResolvedValue({ prompt: { outcome: 'journaled' } })
    const state = buildProfileStateCutoverFixture('/fixture')
    state.repos[0].hookSettings = {
      mode: 'auto',
      scripts: { setup: 'echo setup', archive: '' },
      setupRunPolicy: 'run-by-default'
    }
    // SAFETY: the mocked host launch and target enrichment do not call runtime services in this boundary test.
    const runtime = {} as OrcaRuntimeService
    await launchAutomationChatAgent(runtime, {
      automation: {
        ...state.automations[0],
        workspaceMode: 'new_per_run',
        workspaceId: null,
        reuseSession: false,
        setupDecision
      },
      run: state.automationRuns[0],
      runs: [],
      target: { ok: true, repo: state.repos[0], cwd: state.repos[0].path }
    })
    expect(launch).toHaveBeenCalledOnce()
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'chat',
        target: {
          kind: 'create-worktree',
          create: expect.objectContaining({ setupDecision: setupDecision ?? 'skip' })
        }
      }),
      expect.anything(),
      expect.anything()
    )
  }
)
