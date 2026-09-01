import { describe, expect, it } from 'vitest'
import { buildInteractiveLaunchParams } from './interactive-worktree-launch-params'
import type { TuiAgent } from '../../../src/shared/types'

// Canonical minted shape: custom-agent:<base>:<lowercase UUID> (see mintCustomTuiAgentId).
const CUSTOM_ID = 'custom-agent:claude:0f8b7c6a-1d2e-4a3b-9c4d-5e6f7a8b9c0d' as TuiAgent

describe('buildInteractiveLaunchParams', () => {
  it('launches no agent for a blank terminal', () => {
    const params = buildInteractiveLaunchParams({
      selectedAgentId: '__blank__',
      hasIdentityCapability: true,
      deferToHostDefault: false,
      legacyCommand: undefined
    })
    expect(params).toEqual({})
  })

  it('sends identity-only agentLaunch for an explicit agent on a capable host', () => {
    const params = buildInteractiveLaunchParams({
      selectedAgentId: 'codex',
      hasIdentityCapability: true,
      deferToHostDefault: false,
      legacyCommand: 'codex'
    })
    expect(params).toEqual({
      agentLaunch: { selection: { kind: 'agent', agent: 'codex' }, allowEmptyPromptLaunch: true }
    })
  })

  it('defers to the host default when the agent was not overridden', () => {
    const params = buildInteractiveLaunchParams({
      selectedAgentId: 'claude',
      hasIdentityCapability: true,
      deferToHostDefault: true,
      legacyCommand: 'claude'
    })
    expect(params).toEqual({
      agentLaunch: { selection: { kind: 'default' }, allowEmptyPromptLaunch: true }
    })
  })

  it('never leaks a client command/createdWithAgent on the capable path', () => {
    const params = buildInteractiveLaunchParams({
      selectedAgentId: 'claude',
      hasIdentityCapability: true,
      deferToHostDefault: false,
      legacyCommand: 'claude --dangerously'
    })
    expect(params).not.toHaveProperty('startupCommand')
    expect(params).not.toHaveProperty('startupEnv')
    expect(params).not.toHaveProperty('createdWithAgent')
  })

  it('routes a custom agent id through agentLaunch (the only custom-admitting field)', () => {
    const params = buildInteractiveLaunchParams({
      selectedAgentId: CUSTOM_ID,
      hasIdentityCapability: true,
      deferToHostDefault: false,
      legacyCommand: undefined
    })
    expect(params).toEqual({
      agentLaunch: { selection: { kind: 'agent', agent: CUSTOM_ID }, allowEmptyPromptLaunch: true }
    })
  })

  it('keeps the legacy startupCommand + createdWithAgent path for incapable hosts', () => {
    const params = buildInteractiveLaunchParams({
      selectedAgentId: 'codex',
      hasIdentityCapability: false,
      deferToHostDefault: true,
      legacyCommand: 'codex'
    })
    expect(params).toEqual({ startupCommand: 'codex', createdWithAgent: 'codex' })
    expect(params).not.toHaveProperty('agentLaunch')
  })

  it('fails visibly when a custom selection reaches the legacy path (probe failed)', () => {
    expect(() =>
      buildInteractiveLaunchParams({
        selectedAgentId: CUSTOM_ID,
        hasIdentityCapability: false,
        deferToHostDefault: false,
        legacyCommand: undefined
      })
    ).toThrow(/custom agents/)
  })

  it('omits startupCommand on the legacy path when no command resolved', () => {
    const params = buildInteractiveLaunchParams({
      selectedAgentId: 'claude',
      hasIdentityCapability: false,
      deferToHostDefault: false,
      legacyCommand: undefined
    })
    expect(params).toEqual({ createdWithAgent: 'claude' })
    expect(params).not.toHaveProperty('startupCommand')
  })
})
