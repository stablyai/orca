import { describe, expect, it } from 'vitest'

import type { CommandSpec } from './command-spec'
import {
  AGENT_CONTEXT_QUERY_SCHEMA_VERSION,
  buildAgentContextQuery,
  formatAgentContextQuery
} from './agent-context-query'
import { buildAgentContext } from './agent-context'
import { COMMAND_SPECS } from './specs'

const SPECS: CommandSpec[] = [
  {
    path: ['worktree', 'rm'],
    aliases: [['worktree', 'remove']],
    destructive: true,
    summary: 'Remove a worktree',
    usage: 'orca worktree rm --worktree <selector>',
    allowedFlags: ['worktree', 'force']
  },
  {
    path: ['setup'],
    summary: 'Show setup state',
    usage: 'orca setup',
    allowedFlags: []
  },
  {
    path: ['agent', 'hooks', 'status'],
    summary: 'Show agent setup hooks state',
    usage: 'orca agent hooks status',
    allowedFlags: [],
    notes: ['Reads hook configuration locally.']
  },
  {
    path: ['worktree', 'create'],
    summary: 'Create a worktree with setup policy',
    usage: 'orca worktree create --name <name>',
    allowedFlags: ['name', 'setup'],
    examples: ['orca worktree create --name demo']
  }
]

describe('buildAgentContextQuery', () => {
  it('lists sorted canonical roots without counting aliases', () => {
    const schema = buildAgentContextQuery(SPECS, { view: 'roots' })

    expect(schema).toEqual({
      schemaVersion: AGENT_CONTEXT_QUERY_SCHEMA_VERSION,
      registrySchemaVersion: 1,
      view: 'roots',
      registryCommandCount: 4,
      rootCount: 3,
      roots: [
        { root: 'agent', commandCount: 1 },
        { root: 'setup', commandCount: 1 },
        { root: 'worktree', commandCount: 2 }
      ]
    })
  })

  it('resolves aliases to one canonical full command', () => {
    const schema = buildAgentContextQuery(SPECS, {
      view: 'command',
      value: 'worktree remove',
      detail: 'full'
    })

    expect(schema.view).toBe('command')
    if (schema.view === 'roots') {
      throw new Error('expected a command query')
    }
    expect(schema.detail).toBe('full')
    expect(schema.matchCount).toBe(1)
    expect(schema.commands[0]).toMatchObject({
      command: 'worktree rm',
      destructive: true,
      flags: expect.arrayContaining(['force', 'json', 'help'])
    })
  })

  it('matches prefixes on complete path tokens and returns summaries by default', () => {
    const schema = buildAgentContextQuery(SPECS, {
      view: 'prefix',
      value: 'worktree',
      detail: 'summary'
    })

    if (schema.view === 'roots') {
      throw new Error('expected a command query')
    }
    expect(schema.commands.map((command) => command.command)).toEqual([
      'worktree create',
      'worktree rm'
    ])
    expect(schema.commands[0]).not.toHaveProperty('flags')
    expect(() =>
      buildAgentContextQuery(SPECS, {
        view: 'prefix',
        value: 'work',
        detail: 'summary'
      })
    ).toThrow('Unknown Orca command prefix: work')
  })

  it('matches an alias prefix but returns its canonical command', () => {
    const schema = buildAgentContextQuery(SPECS, {
      view: 'prefix',
      value: 'worktree remove',
      detail: 'summary'
    })

    if (schema.view === 'roots') {
      throw new Error('expected a command query')
    }
    expect(schema.commands.map((command) => command.command)).toEqual(['worktree rm'])
  })

  it('uses AND search terms across metadata and deterministic relevance tiers', () => {
    const exact = buildAgentContextQuery(SPECS, {
      view: 'search',
      value: 'setup',
      detail: 'summary',
      limit: 20
    })
    const andTerms = buildAgentContextQuery(SPECS, {
      view: 'search',
      value: 'setup hooks',
      detail: 'summary',
      limit: 20
    })

    if (exact.view === 'roots' || andTerms.view === 'roots') {
      throw new Error('expected command queries')
    }
    expect(exact.commands.map((command) => command.command)).toEqual([
      'setup',
      'agent hooks status',
      'worktree create'
    ])
    expect(andTerms.commands.map((command) => command.command)).toEqual(['agent hooks status'])
  })

  it('bounds search output and reports truncation separately from matches', () => {
    const schema = buildAgentContextQuery(SPECS, {
      view: 'search',
      value: 'worktree',
      detail: 'full',
      limit: 1
    })

    if (schema.view === 'roots') {
      throw new Error('expected a command query')
    }
    expect(schema).toMatchObject({
      detail: 'full',
      matchCount: 2,
      returnedCount: 1,
      truncated: true
    })
    expect(schema.commands[0]).toHaveProperty('flags')
  })

  it('returns a successful empty search instead of an error', () => {
    const schema = buildAgentContextQuery(SPECS, {
      view: 'search',
      value: 'does-not-exist',
      detail: 'summary',
      limit: 20
    })

    if (schema.view === 'roots') {
      throw new Error('expected a command query')
    }
    expect(schema).toMatchObject({
      matchCount: 0,
      returnedCount: 0,
      truncated: false,
      commands: []
    })
    expect(formatAgentContextQuery(schema)).toBe('No commands matched "does-not-exist".')
  })

  it('returns bounded recovery for unknown exact commands and prefixes', () => {
    try {
      buildAgentContextQuery(SPECS, {
        view: 'command',
        value: 'worktree creat',
        detail: 'full'
      })
      throw new Error('expected command lookup to fail')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'invalid_argument',
        data: {
          suggestions: ['worktree create']
        }
      })
    }

    try {
      buildAgentContextQuery(SPECS, {
        view: 'prefix',
        value: 'unknown',
        detail: 'summary'
      })
      throw new Error('expected prefix lookup to fail')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'invalid_argument',
        data: {
          availableRoots: ['agent', 'setup', 'worktree']
        }
      })
    }
  })
})

describe('agent-context queries over the live registry', () => {
  it('returns a deterministic bounded subset instead of the full schema', () => {
    const full = buildAgentContext(COMMAND_SPECS)
    const schema = buildAgentContextQuery(COMMAND_SPECS, {
      view: 'prefix',
      value: 'worktree',
      detail: 'summary'
    })

    if (schema.view === 'roots') {
      throw new Error('expected a command query')
    }
    const registryCommands = new Set(full.commands.map((command) => command.command))
    expect(schema.commands.length).toBeGreaterThan(0)
    expect(schema.commands.length).toBeLessThan(full.commands.length)
    expect(schema.commands.every((command) => registryCommands.has(command.command))).toBe(true)
    expect(schema.commands.every((command) => !('flags' in command))).toBe(true)
    expect(JSON.stringify(schema).length).toBeLessThan(JSON.stringify(full).length)
  })
})
