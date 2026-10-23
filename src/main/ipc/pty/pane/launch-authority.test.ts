import { describe, expect, it } from 'vitest'
import {
  admitProviderReattachLaunchIdentity,
  shouldRefreshNativeClaudeAgentTeamsEnv
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

describe('shouldRefreshNativeClaudeAgentTeamsEnv', () => {
  it.each([
    { command: 'claude --teammate-mode auto', expected: true },
    { command: 'claude --teammate-mode iterm2', expected: true },
    { command: 'claude --teammate-mode=iterm2 --resume x', expected: true },
    { command: 'claude --teammate-mode in-process', expected: false },
    { command: 'claude --teammate-mode iterm22', expected: false },
    { command: 'claude', expected: false }
  ])('reads $command from the command', ({ command, expected }) => {
    expect(shouldRefreshNativeClaudeAgentTeamsEnv({ command })).toBe(expected)
  })

  it('reads the teammate mode from captured launch args', () => {
    expect(
      shouldRefreshNativeClaudeAgentTeamsEnv({
        command: 'claude --resume x',
        launchConfig: { agentCommand: 'claude', agentArgs: '--teammate-mode iterm2', agentEnv: {} }
      })
    ).toBe(true)
  })
})
