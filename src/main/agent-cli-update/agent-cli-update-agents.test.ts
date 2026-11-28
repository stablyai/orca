import { describe, expect, it } from 'vitest'
import { agentCliUpdateDefinition } from './agent-cli-update-agents'

const SELF_UPDATE = { runnable: true, args: ['update'] }

describe('Pi updates', () => {
  const pi = agentCliUpdateDefinition('pi')

  it('looks up the installed npm scope, not a similarly named parent directory', () => {
    expect(
      pi.latest('0.71.0', 'C:\\npm\\node_modules\\@mariozechner\\pi-coding-agent\\dist\\cli.js')
    ).toEqual({ kind: 'npm', package: '@mariozechner/pi-coding-agent' })
    expect(pi.latest('1.6.0', '/home/@mariozechner/pi-coding-agent/.pi/agent/bin/pi')).toEqual({
      kind: 'npm',
      package: '@earendil-works/pi-coding-agent'
    })
  })

  it('keeps pre-self-update releases on their package manager', () => {
    const path =
      '/home/a/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/cli.js'
    expect(pi.plan('0.70.2', path)).toEqual({
      runnable: false,
      command: 'bun install -g --ignore-scripts @mariozechner/pi-coding-agent@latest'
    })
    expect(pi.plan('0.70.3', path)).toEqual({ runnable: true, args: ['update', '--self'] })
  })

  it('leaves Homebrew Pi updates to Homebrew', () => {
    expect(pi.plan('1.6.0', '/opt/homebrew/Cellar/pi-coding-agent/1.6.0/bin/pi')).toEqual({
      runnable: false,
      command: 'brew upgrade pi-coding-agent'
    })
  })
})

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
