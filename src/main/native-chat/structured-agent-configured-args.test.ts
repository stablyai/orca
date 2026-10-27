import { describe, expect, it } from 'vitest'
import { structuredAgentConfiguredArgs } from './structured-agent-configured-args'

describe('structured chat configured Arguments', () => {
  it.each(['claude', 'codex', 'opencode', 'omp', 'grok'] as const)(
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

describe('future structured provider argument lookup', () => {
  it('keeps configured arguments and empty fallback for an unregistered provider', () => {
    const agentDefaultArgs = { claude: '', 'future-provider': '--label "future value"' }
    expect(structuredAgentConfiguredArgs('future-provider', { agentDefaultArgs })).toEqual([
      '--label',
      'future value'
    ])
    expect(structuredAgentConfiguredArgs('future-provider', {})).toEqual([])
  })
})
