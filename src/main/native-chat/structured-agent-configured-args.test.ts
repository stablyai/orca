import { describe, expect, it } from 'vitest'
import { structuredAgentConfiguredArgs } from './structured-agent-configured-args'

describe('structured chat configured Arguments', () => {
  it.each(['claude', 'codex'] as const)(
    'reads the existing %s setting and preserves quoted values',
    (agent) => {
      expect(
        structuredAgentConfiguredArgs(
          agent,
          {
            agentDefaultArgs: { [agent]: '--model "model with spaces"' }
          },
          'darwin'
        )
      ).toEqual(['--model', 'model with spaces'])
      expect(structuredAgentConfiguredArgs(agent, { agentDefaultArgs: { [agent]: '' } })).toEqual(
        []
      )
    }
  )

  // The bypass flag comes from the stored permission mode, never from Arguments.
  it('reads no arguments when the Arguments key is absent', () => {
    expect(structuredAgentConfiguredArgs('claude', {})).toEqual([])
  })

  it('preserves Windows paths under the configured shell', () => {
    expect(
      structuredAgentConfiguredArgs(
        'claude',
        {
          agentDefaultArgs: { claude: String.raw`--plugin-dir "C:\My Plugins"` },
          terminalWindowsShell: 'powershell'
        },
        'win32'
      )
    ).toEqual(['--plugin-dir', String.raw`C:\My Plugins`])
  })

  it('refuses unclosed quotes without spawning', () => {
    expect(() =>
      structuredAgentConfiguredArgs('claude', {
        agentDefaultArgs: { claude: '--model "unfinished' }
      })
    ).toThrow('Arguments are invalid')
  })
})
