import { describe, expect, it } from 'vitest'
import { normalizeCommandPositionals, parseArgs, specPaths, validateCommandAndFlags } from './args'
import { buildAgentContext } from './agent-context'
import { getRepeatedStringFlag } from './flags'
import { COMMAND_SPECS } from './specs'

function parse(argv: string[]) {
  return normalizeCommandPositionals(
    COMMAND_SPECS,
    parseArgs(argv, COMMAND_SPECS.flatMap(specPaths), COMMAND_SPECS)
  )
}

describe('reference command arguments', () => {
  it('collects variadic URLs around flags without losing or reordering values', () => {
    const parsed = parse(['reference', 'add', 'one', '--worktree', 'name:api', 'two', 'three'])
    validateCommandAndFlags(COMMAND_SPECS, parsed)
    expect(parsed.commandPath).toEqual(['reference', 'add'])
    expect(getRepeatedStringFlag(parsed.flags, 'url')).toEqual(['one', 'two', 'three'])
  })

  it('accepts repeated remove keys with positional URLs', () => {
    const parsed = parse(['reference', 'remove', 'url', '--key', 'first', '--key', 'second'])
    validateCommandAndFlags(COMMAND_SPECS, parsed)
    expect(getRepeatedStringFlag(parsed.flags, 'url')).toEqual(['url'])
    expect(getRepeatedStringFlag(parsed.flags, 'key')).toEqual(['first', 'second'])
  })

  it('rejects positional and named forms of the same argument', () => {
    const parsed = parse(['reference', 'add', 'one', 'two', '--url', 'three'])
    expect(() => validateCommandAndFlags(COMMAND_SPECS, parsed)).toThrow('not both')
  })

  it('does not accept extra arguments on commands without variadic positionals', () => {
    const parsed = parse(['reference', 'find', 'STA-1', 'STA-2'])
    expect(() => validateCommandAndFlags(COMMAND_SPECS, parsed)).toThrow('Unknown command')
  })

  it('exposes repeatability to agents and excludes browser targeting', () => {
    const schema = buildAgentContext(COMMAND_SPECS)
    const add = schema.commands.find((command) => command.command === 'reference add')
    expect(add).toMatchObject({
      positionalArgs: ['url'],
      variadicPositional: true,
      repeatableFlags: ['url']
    })
    expect(add?.flags).not.toContain('page')
    const create = schema.commands.find((command) => command.command === 'worktree create')
    expect(create?.repeatableFlags).toEqual(['reference'])
  })
})
