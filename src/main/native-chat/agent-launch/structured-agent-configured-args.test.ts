import { describe, expect, it } from 'vitest'
import { structuredAgentConfiguredArgs } from './structured-agent-configured-args'

describe('structured chat configured Arguments', () => {
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
