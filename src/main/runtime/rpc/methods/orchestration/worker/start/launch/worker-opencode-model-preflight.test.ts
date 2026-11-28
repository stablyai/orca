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
  it('probes OpenCode itself on the base route', async () => {
    const { runtime, probe } = runtimeProbing()

    await probeWorkerOpenCodeModelLaunchSupport(
      runtime,
      { agent: 'opencode', model: 'openai/gpt-5' },
      { worktree: 'id:wt' }
    )
    expect(probe).toHaveBeenCalledWith({ worktree: 'id:wt', model: 'openai/gpt-5' })
  })

  it('probes an OpenCode copy on its own launch route', async () => {
    const { runtime, probe } = runtimeProbing()

    await expect(
      probeWorkerOpenCodeModelLaunchSupport(
        runtime,
        { agent: 'opencode.fast', model: 'openai/gpt-5' },
        { worktree: 'id:wt' }
      )
    ).resolves.toBe(true)
    expect(probe).toHaveBeenCalledWith({
      worktree: 'id:wt',
      model: 'openai/gpt-5',
      agentCopy: 'opencode.fast'
    })
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
