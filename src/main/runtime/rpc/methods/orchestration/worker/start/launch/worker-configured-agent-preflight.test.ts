import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../../../orca-runtime'
import { resolveWorkerConfiguredAgentParams } from './worker-configured-agent-preflight'

function runtimeResolving(agent: string | undefined) {
  const resolveOrchestrationAgentLauncherForTarget = vi.fn(async () => agent)
  return {
    runtime: { resolveOrchestrationAgentLauncherForTarget } as unknown as OrcaRuntimeService,
    resolveOrchestrationAgentLauncherForTarget
  }
}

describe('resolveWorkerConfiguredAgentParams', () => {
  it('passes an agent copy id through to the copy-aware worker launch', async () => {
    const { runtime, resolveOrchestrationAgentLauncherForTarget } = runtimeResolving(undefined)
    const params = { agent: 'claude.claude-code-mode', worktree: 'id:wt' }

    await expect(
      resolveWorkerConfiguredAgentParams(runtime, params, async () => ({ worktree: 'id:wt' }))
    ).resolves.toBe(params)
    expect(resolveOrchestrationAgentLauncherForTarget).not.toHaveBeenCalled()
  })

  it('resolves a configured command alias to its agent', async () => {
    const { runtime } = runtimeResolving('claude')

    await expect(
      resolveWorkerConfiguredAgentParams(runtime, { agent: 'claude-secrets' }, async () => ({}))
    ).resolves.toEqual({ agent: 'claude' })
  })

  it('still refuses a selector that is neither an agent, a copy id nor a configured alias', async () => {
    const { runtime } = runtimeResolving(undefined)

    await expect(
      resolveWorkerConfiguredAgentParams(runtime, { agent: 'not-an-agent' }, async () => ({}))
    ).rejects.toMatchObject({ code: 'agent_unconfigured' })
  })
})
