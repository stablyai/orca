import { describe, expect, it } from 'vitest'
import { agentCliUpdateDefinition } from './agent-cli-update-agents'

const SELF_UPDATE = { runnable: true, args: ['update'] }

describe('claude update plan', () => {
  it.each([
    [
      '/opt/homebrew/Caskroom/claude-code@latest/2.1.330/claude',
      { runnable: false, command: 'brew upgrade --cask claude-code@latest' }
    ],
    // The stable cask lags the latest channel Orca compares against.
    ['/opt/homebrew/Caskroom/claude-code/2.1.323/claude', SELF_UPDATE],
    // A mise shim on PATH resolves into mise's own keg.
    ['/opt/homebrew/Cellar/mise/2026.11.0/bin/mise', SELF_UPDATE],
    [
      'C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe',
      { runnable: false, command: 'winget upgrade Anthropic.ClaudeCode' }
    ]
  ])('%s', (realPath, plan) => {
    expect(agentCliUpdateDefinition('claude').plan('2.1.323', realPath)).toEqual(plan)
  })
})
