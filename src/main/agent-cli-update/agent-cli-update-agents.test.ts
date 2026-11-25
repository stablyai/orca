import { describe, expect, it } from 'vitest'
import type { AgentCliUpdateAgent } from '../../shared/agent-launch/installation/agent-cli-update'
import {
  agentCliUpdateDefinition,
  agentCliUpdatePlan,
  type AgentCliUpdatePlan
} from './agent-cli-update-agents'

const SELF_UPDATE: AgentCliUpdatePlan = { runnable: true, args: ['update'] }
const manual = (command: string): AgentCliUpdatePlan => ({ runnable: false, command })

describe('agentCliUpdatePlan', () => {
  // The PATH command only matters for npm, whose global bins sit beside its global node_modules.
  it.each<[AgentCliUpdateAgent, string, string, AgentCliUpdatePlan, string?]>([
    [
      'claude',
      '2.1.323',
      '/opt/homebrew/Caskroom/claude-code@latest/2.1.330/claude',
      manual('brew upgrade --cask claude-code@latest')
    ],
    [
      'claude',
      '2.1.323',
      '/opt/homebrew/Caskroom/claude-code/2.1.323/claude',
      manual('brew upgrade --cask claude-code')
    ],
    // A mise shim on PATH resolves into mise's own keg.
    ['claude', '2.1.323', '/opt/homebrew/Cellar/mise/2026.11.0/bin/mise', SELF_UPDATE],
    [
      'claude',
      '2.1.323',
      'C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe',
      manual('winget upgrade Anthropic.ClaudeCode')
    ],
    // `claude update` updates a machine-scope WinGet install itself.
    [
      'claude',
      '2.1.323',
      'C:\\Program Files\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe',
      SELF_UPDATE
    ],
    [
      'claude',
      '2.1.323',
      '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
      SELF_UPDATE,
      '/usr/local/bin/claude'
    ],
    [
      'qwen-code',
      '0.21.0',
      '/opt/homebrew/lib/node_modules/@qwen-code/qwen-code/cli.js',
      manual('npm install -g @qwen-code/qwen-code@latest'),
      '/opt/homebrew/bin/qwen'
    ],
    [
      'qwen-code',
      '0.21.0',
      'C:\\tools\\node_modules\\@qwen-code\\qwen-code\\cli.js',
      manual('npm install -g @qwen-code/qwen-code@latest'),
      'C:\\tools\\qwen.cmd'
    ],
    [
      'qwen-code',
      '0.21.0',
      '/Users/a/.bun/install/global/node_modules/@qwen-code/qwen-code/cli.js',
      manual('bun add -g @qwen-code/qwen-code@latest')
    ],
    // A project's own copy isn't a global install.
    [
      'qwen-code',
      '0.21.0',
      '/work/lib/node_modules/@qwen-code/qwen-code/cli.js',
      SELF_UPDATE,
      '/work/lib/node_modules/.bin/qwen'
    ],
    [
      'qwen-code',
      '0.21.0',
      '/opt/homebrew/Cellar/qwen-code/0.21.0/libexec/lib/node_modules/@qwen-code/qwen-code/cli.js',
      manual('brew upgrade qwen-code')
    ],
    [
      'codex',
      '0.120.0',
      '/Users/a/Library/pnpm/global/v11/13aa9-1a211c9e393/node_modules/@openai/codex/bin/codex.js',
      manual('pnpm add -g @openai/codex@latest')
    ]
  ])('%s %s at %s', (agent, installed, installPath, plan, program = installPath) => {
    expect(agentCliUpdatePlan(agent, installed, { program, installPath })).toEqual(plan)
  })
})

describe('claude release source', () => {
  it('compares the stable cask with the stable channel, which is all it carries', () => {
    const { latest } = agentCliUpdateDefinition('claude')
    expect(latest('2.1.326', '/opt/homebrew/Caskroom/claude-code/2.1.326/claude')).toEqual({
      kind: 'claude',
      channel: 'stable'
    })
    expect(latest('2.1.326', '/opt/homebrew/Caskroom/claude-code@latest/2.1.326/claude')).toEqual({
      kind: 'claude'
    })
  })
})
