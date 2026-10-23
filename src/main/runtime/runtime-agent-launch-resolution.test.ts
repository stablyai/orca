import { describe, expect, it } from 'vitest'
import { inferCapturedClaudeAgentTeamsMode } from './runtime-agent-launch-resolution'

describe('inferCapturedClaudeAgentTeamsMode', () => {
  it.each([
    { command: 'claude --teammate-mode auto', expected: 'native-panes-shim' },
    { command: 'claude --teammate-mode iterm2', expected: 'native-panes-shim' },
    { command: 'claude --teammate-mode=iterm2', expected: 'native-panes-shim' },
    { command: 'claude --teammate-mode in-process', expected: 'in-process' },
    { command: 'claude', expected: 'off' }
  ] as const)('maps $command to $expected', ({ command, expected }) => {
    expect(inferCapturedClaudeAgentTeamsMode(undefined, command, 'off')).toBe(expected)
  })

  it('reads an iterm2 request from captured launch args', () => {
    expect(
      inferCapturedClaudeAgentTeamsMode(
        { agentCommand: 'claude', agentArgs: '--teammate-mode iterm2', agentEnv: {} },
        'claude',
        'off'
      )
    ).toBe('native-panes-shim')
  })
})
