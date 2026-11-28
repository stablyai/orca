import { describe, expect, it } from 'vitest'
import { agentCliUpdateDefinition } from './agent-cli-update-agents'

const SELF_UPDATE = { runnable: true, args: ['update'] }
const claude = agentCliUpdateDefinition('claude')

describe('claude update plan', () => {
  it.each([
    [
      '/opt/homebrew/Caskroom/claude-code@latest/2.1.330/claude',
      { runnable: false, command: 'brew upgrade --cask claude-code@latest' }
    ],
    [
      '/opt/homebrew/Caskroom/claude-code/2.1.323/claude',
      { runnable: false, command: 'brew upgrade --cask claude-code' }
    ],
    // A mise shim on PATH resolves into mise's own keg.
    ['/opt/homebrew/Cellar/mise/2026.11.0/bin/mise', SELF_UPDATE],
    [
      'C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe',
      { runnable: false, command: 'winget upgrade Anthropic.ClaudeCode' }
    ]
  ])('%s', (realPath, plan) => {
    expect(claude.plan('2.1.323', realPath)).toEqual(plan)
  })
})

describe('claude release source', () => {
  it('compares the stable cask with the stable channel, which is all it carries', () => {
    expect(claude.latest('2.1.326', '/opt/homebrew/Caskroom/claude-code/2.1.326/claude')).toEqual({
      kind: 'claude',
      channel: 'stable'
    })
    expect(
      claude.latest('2.1.326', '/opt/homebrew/Caskroom/claude-code@latest/2.1.326/claude')
    ).toEqual({ kind: 'claude' })
  })
})
