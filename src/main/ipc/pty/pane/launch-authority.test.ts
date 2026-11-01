import { describe, expect, it } from 'vitest'
import {
  admitProviderReattachLaunchIdentity,
  admitRendererAgentLaunchAuthority
} from './launch-authority'

describe('admitProviderReattachLaunchIdentity', () => {
  it('binds provider launch identity to a valid reattach incarnation', () => {
    expect(
      admitProviderReattachLaunchIdentity({
        isReattach: true,
        launchAgent: 'codex',
        incarnationId: 'provider-incarnation'
      })
    ).toEqual({ launchAgent: 'codex', incarnationId: 'provider-incarnation' })
  })

  it.each([
    { label: 'fresh spawn', isReattach: false, launchAgent: 'codex', incarnationId: 'incarnation' },
    {
      label: 'invalid agent',
      isReattach: true,
      launchAgent: 'unknown',
      incarnationId: 'incarnation'
    },
    {
      label: 'missing incarnation',
      isReattach: true,
      launchAgent: 'codex',
      incarnationId: undefined
    },
    {
      label: 'oversized incarnation',
      isReattach: true,
      launchAgent: 'codex',
      incarnationId: 'x'.repeat(129)
    }
  ])('rejects $label metadata', ({ isReattach, launchAgent, incarnationId }) => {
    expect(
      admitProviderReattachLaunchIdentity({ isReattach, launchAgent, incarnationId })
    ).toBeNull()
  })
})

describe('admitRendererAgentLaunchAuthority', () => {
  it('returns a copy of the admitted launch recipe', () => {
    const launchConfig = {
      agentCommand: 'claude',
      agentArgs: '--dangerously-skip-permissions',
      agentEnv: { A: '1' }
    }
    const admitted = admitRendererAgentLaunchAuthority({
      launchToken: 'token',
      spawnEnv: { ORCA_AGENT_LAUNCH_TOKEN: 'token' },
      launchAgent: 'claude',
      launchConfig,
      isReattach: false,
      hasStablePaneOwner: false,
      incarnationId: 'incarnation'
    })
    expect(admitted?.launchConfig).toEqual(launchConfig)
    expect(admitted?.launchConfig).not.toBe(launchConfig)
    expect(admitted?.launchConfig?.agentEnv).not.toBe(launchConfig.agentEnv)
  })

  it('keeps an unrecorded resume recipe off the main pty record', () => {
    const admitted = admitRendererAgentLaunchAuthority({
      launchToken: 'token',
      spawnEnv: { ORCA_AGENT_LAUNCH_TOKEN: 'token' },
      launchAgent: 'claude',
      launchConfig: { agentArgs: '', agentEnv: {}, unrecorded: true },
      isReattach: false,
      hasStablePaneOwner: false,
      incarnationId: 'incarnation'
    })
    expect(admitted).toMatchObject({ launchToken: 'token', launchAgent: 'claude' })
    expect(admitted?.launchConfig).toBeUndefined()
  })
})
