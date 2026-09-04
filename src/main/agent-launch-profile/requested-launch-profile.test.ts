import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_LAUNCH_PROFILE_AGENT_MISMATCH,
  AGENT_SESSION_LAUNCH_PROFILE_UNKNOWN,
  resolveRequestedAgentLaunchProfile
} from './requested-launch-profile'

const settings = {
  agentLaunchProfiles: [{ id: 'codex-work', agent: 'codex' as const, args: '-c a=b' }]
}

describe('resolveRequestedAgentLaunchProfile', () => {
  it('returns null for a plain launch', () => {
    expect(
      resolveRequestedAgentLaunchProfile({
        agent: 'codex',
        launchProfileId: undefined,
        settings
      })
    ).toBeNull()
  })

  it('resolves built-in and custom profiles for the matching agent', () => {
    expect(
      resolveRequestedAgentLaunchProfile({
        agent: 'codex',
        launchProfileId: 'codex-secondary-home',
        settings
      })?.home?.envVar
    ).toBe('CODEX_HOME')
    expect(
      resolveRequestedAgentLaunchProfile({
        agent: 'codex',
        launchProfileId: 'codex-work',
        settings
      })?.args
    ).toBe('-c a=b')
  })

  it('names the failure so clients can tell unknown from mismatch', () => {
    expect(() =>
      resolveRequestedAgentLaunchProfile({
        agent: 'codex',
        launchProfileId: 'missing',
        settings
      })
    ).toThrow(AGENT_SESSION_LAUNCH_PROFILE_UNKNOWN)
    expect(() =>
      resolveRequestedAgentLaunchProfile({
        agent: 'claude',
        launchProfileId: 'codex-work',
        settings
      })
    ).toThrow(AGENT_SESSION_LAUNCH_PROFILE_AGENT_MISMATCH)
  })

  it('does not refuse a secondary home up front; the SSH lane resolves it at spawn', () => {
    expect(
      resolveRequestedAgentLaunchProfile({
        agent: 'claude',
        launchProfileId: 'claude-secondary-home',
        settings
      })?.id
    ).toBe('claude-secondary-home')
  })
})
