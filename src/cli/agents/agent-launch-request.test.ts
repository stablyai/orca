import { describe, expect, it, vi } from 'vitest'
import { AGENT_LAUNCH_RUNTIME_CAPABILITIES } from '../../shared/agent-launch/contracts/agent-launch-runtime-capability'
import { RuntimeClient } from '../runtime/client'
import { callAgentLaunch, readCliAgentLaunch } from './agent-launch-request'

describe('mistral-vibe CLI launch', () => {
  it('reads Vibe --model and --effort flags into sessionOptions', () => {
    const flags = new Map([
      ['model', 'mistral-large-4'],
      ['effort', 'high']
    ])

    expect(
      readCliAgentLaunch(flags, 'mistral-vibe', { createsWorktree: true }).sessionOptions
    ).toEqual({
      model: 'mistral-large-4',
      effort: 'high'
    })
  })

  it('refuses a Vibe model on a host without the mistral-vibe-model capability', async () => {
    const client = new RuntimeClient('/nonexistent-orca-test-profile')
    const callSpy = vi.spyOn(client, 'call').mockRejectedValue(new Error('unexpected rpc call'))
    const capabilities = AGENT_LAUNCH_RUNTIME_CAPABILITIES.filter(
      (capability) => capability !== 'agent.launch.mistral-vibe-model.v1'
    )

    await expect(
      callAgentLaunch(
        client,
        { agent: 'mistral-vibe', sessionOptions: { model: 'mistral-large-4' } },
        { target: { kind: 'existing', worktree: 'repo-1::/tmp/repo' } },
        capabilities
      )
    ).rejects.toMatchObject({ code: 'incompatible_runtime' })
    expect(callSpy).not.toHaveBeenCalled()
  })
})
