import { describe, expect, it } from 'vitest'
import { getWorktreeStartupAgentFlags } from './worktree-startup-agent-flags'

function flags(entries: Record<string, string | boolean>): Map<string, string | boolean> {
  return new Map(Object.entries(entries))
}

describe('getWorktreeStartupAgentFlags', () => {
  it('returns nothing without --agent', () => {
    expect(getWorktreeStartupAgentFlags(flags({}))).toEqual({})
  })

  it('requires --agent for --prompt and --launch-profile', () => {
    expect(() => getWorktreeStartupAgentFlags(flags({ prompt: 'hi' }))).toThrow(
      '--prompt requires --agent'
    )
    expect(() =>
      getWorktreeStartupAgentFlags(flags({ 'launch-profile': 'codex-secondary-home' }))
    ).toThrow('--launch-profile requires --agent')
  })

  it('passes a well-formed profile id through untouched', () => {
    expect(
      getWorktreeStartupAgentFlags(flags({ agent: 'codex', 'launch-profile': 'codex-work' }))
    ).toEqual({ startupAgent: 'codex', startupLaunchProfileId: 'codex-work' })
    expect(getWorktreeStartupAgentFlags(flags({ agent: 'codex' }))).toEqual({
      startupAgent: 'codex'
    })
  })

  it('rejects malformed ids and unknown agents locally', () => {
    expect(() =>
      getWorktreeStartupAgentFlags(flags({ agent: 'codex', 'launch-profile': 'Not A Slug' }))
    ).toThrow(/Invalid --launch-profile/)
    expect(() => getWorktreeStartupAgentFlags(flags({ agent: 'nope' }))).toThrow(
      'Unknown TUI agent "nope"'
    )
    expect(() =>
      getWorktreeStartupAgentFlags(flags({ agent: 'codex', 'launch-profile': '' }))
    ).toThrow('Missing value for --launch-profile')
  })
})
