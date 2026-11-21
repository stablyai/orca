import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../../../orca-runtime'
import { isTuiAgent } from '../../../../../../../../shared/agent-launch/catalog/tui-agent-config'
import { probeWorkerOpenCodeModelLaunchSupport } from './worker-opencode-model-preflight'

function runtimeProbing(): {
  runtime: Pick<
    OrcaRuntimeService,
    'resolveOrchestrationAgentLauncher' | 'probeOrchestrationOpenCodeModelLaunchSupport'
  >
  probe: ReturnType<typeof vi.fn>
} {
  const probe = vi.fn(async () => true)
  return {
    runtime: {
      resolveOrchestrationAgentLauncher: (selector: string) =>
        isTuiAgent(selector) ? selector : undefined,
      probeOrchestrationOpenCodeModelLaunchSupport: probe
    },
    probe
  }
}

describe('probeWorkerOpenCodeModelLaunchSupport', () => {
  it('probes an OpenCode copy as its base agent', async () => {
    const { runtime, probe } = runtimeProbing()

    await expect(
      probeWorkerOpenCodeModelLaunchSupport(
        runtime,
        { agent: 'opencode.fast', model: 'openai/gpt-5' },
        { worktree: 'id:wt' }
      )
    ).resolves.toBe(true)
    expect(probe).toHaveBeenCalledWith({ worktree: 'id:wt', model: 'openai/gpt-5' })
  })

  it('does not probe a copy of another agent', async () => {
    const { runtime, probe } = runtimeProbing()

    await expect(
      probeWorkerOpenCodeModelLaunchSupport(
        runtime,
        { agent: 'claude.claude-code-mode', model: 'haiku' },
        { worktree: 'id:wt' }
      )
    ).resolves.toBe(false)
    expect(probe).not.toHaveBeenCalled()
  })
})
