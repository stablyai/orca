import { describe, expect, it } from 'vitest'

import type { CommandSpec } from './args'
import { buildAgentContext, formatAgentContextSummary } from './agent-context'
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

  it('emits a versioned envelope with a command count', () => {
    const schema = buildAgentContext(specs)
    expect(schema.schemaVersion).toBe(1)
    expect(schema.commandCount).toBe(2)
    expect(schema.commands).toHaveLength(2)
  })

  it('includes resolved aliases for a command', () => {
    const schema = buildAgentContext(specs)
    const rm = schema.commands.find((command) => command.command === 'worktree rm')
    expect(rm?.aliases).toEqual([
      ['worktree', 'remove'],
      ['worktree', 'delete']
    ])
  })

  it('reports effective flags including globals, not just allowedFlags', () => {
    const schema = buildAgentContext(specs)
    const rm = schema.commands.find((command) => command.command === 'worktree rm')
    expect(rm?.flags).toContain('worktree')
    expect(rm?.flags).toContain('force')
    expect(rm?.flags).toContain('json')
    expect(rm?.flags).toContain('help')
  })

  it('orders commands deterministically', () => {
    const schema = buildAgentContext(specs)
    expect(schema.commands.map((command) => command.command)).toEqual([
      'agent-context',
      'worktree rm'
    ])
  })

  it('defaults optional fields to empty arrays', () => {
    const schema = buildAgentContext(specs)
    const agentContext = schema.commands.find((command) => command.command === 'agent-context')
    expect(agentContext?.aliases).toEqual([])
    expect(agentContext?.examples).toEqual([])
  })
})

describe('agent-context over the live registry', () => {
  it('exposes the worktree rm command with its remove/delete aliases', () => {
    const schema = buildAgentContext(COMMAND_SPECS)
    const rm = schema.commands.find((command) => command.command === 'worktree rm')
    expect(rm).toBeDefined()
    expect(rm?.aliases).toContainEqual(['worktree', 'remove'])
  })

  it('human summary count matches the command count', () => {
    const schema = buildAgentContext(COMMAND_SPECS)
    expect(formatAgentContextSummary(schema)).toContain(`${schema.commandCount} commands`)
  })

  it('does not advertise browser page targeting for local discovery', () => {
    const schema = buildAgentContext(COMMAND_SPECS)
    const agentContext = schema.commands.find((command) => command.command === 'agent-context')
    expect(agentContext?.flags).not.toContain('page')
  })

  it('marks raw passthrough commands without synthesizing Orca flags', () => {
    const schema = buildAgentContext(COMMAND_SPECS)
    const claudeTeams = schema.commands.find((command) => command.command === 'claude-teams')
    expect(claudeTeams?.argumentMode).toBe('passthrough')
    expect(claudeTeams?.flags).toEqual([])
  })
})
