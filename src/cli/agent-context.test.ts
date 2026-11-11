import { describe, expect, it } from 'vitest'

import type { CommandSpec } from './args'
import { buildAgentContext } from './agent-context'
import { COMMAND_SPECS } from './specs'

describe('buildAgentContext', () => {
  const specs: CommandSpec[] = [
    {
      path: ['worktree', 'rm'],
      aliases: [
        ['worktree', 'remove'],
        ['worktree', 'delete']
      ],
      summary: 'Remove a worktree',
      usage: 'orca worktree rm',
      allowedFlags: ['worktree', 'force']
    },
    {
      path: ['agent-context'],
      summary: 'Print the schema',
      usage: 'orca agent-context',
      allowedFlags: []
    }
  ]

  it('reports effective flags including globals, not just allowedFlags', () => {
    const schema = buildAgentContext(specs)
    const rm = schema.commands.find((command) => command.command === 'worktree rm')
    expect(rm?.flags).toContain('worktree')
    expect(rm?.flags).toContain('force')
    expect(rm?.flags).toContain('json')
    expect(rm?.flags).toContain('help')
  })

  it('omits hidden specs so agents do not discover an unadvertised command', () => {
    const schema = buildAgentContext([
      ...specs,
      {
        path: ['terminal', 'stop'],
        summary: 'Deprecated',
        usage: 'orca terminal stop',
        allowedFlags: [],
        hidden: true
      }
    ])
    expect(schema.commandCount).toBe(2)
    expect(schema.commands.map((command) => command.command)).not.toContain('terminal stop')
  })
})

describe('agent-context over the live registry', () => {
  it('marks raw passthrough commands without synthesizing Orca flags', () => {
    const schema = buildAgentContext(COMMAND_SPECS)
    const claudeTeams = schema.commands.find((command) => command.command === 'claude-teams')
    expect(claudeTeams?.argumentMode).toBe('passthrough')
    expect(claudeTeams?.flags).toEqual([])
  })
})
