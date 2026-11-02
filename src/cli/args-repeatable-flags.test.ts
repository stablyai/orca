import { describe, expect, it } from 'vitest'
import { parseArgs, REPEATED_FLAG_SEPARATOR, specPaths, type CommandSpec } from './args'

const leaf: CommandSpec = {
  path: ['example', 'search'],
  aliases: [['ex', 'find']],
  summary: '',
  usage: '',
  allowedFlags: ['agent'],
  repeatableFlags: ['agent']
}
const parent: CommandSpec = {
  path: ['example'],
  summary: '',
  usage: '',
  allowedFlags: ['path'],
  repeatableFlags: ['path']
}
const specs = [parent, leaf]
const paths = specs.flatMap(specPaths)

function flags(argv: string[]) {
  return parseArgs(argv, paths, specs).flags
}

describe('command-scoped repeatable flags', () => {
  it.each(specPaths(leaf))('keeps values before and between %s %s command words', (...path) => {
    const parsed = flags(['--agent', 'a', path[0], '--agent=b', path[1], '--agent', 'c'])
    expect(parsed.get('agent')).toBe(['a', 'b', 'c'].join(REPEATED_FLAG_SEPARATOR))
  })

  it('uses the leaf rules for all flags even when the parent has different rules', () => {
    const parsed = flags(['--path', '/a', 'example', '--path', '/b', 'search', '--path', '/c'])
    expect(parsed.get('path')).toBe('/c')
  })

  it('still uses the parent rules when the parent itself is invoked', () => {
    expect(flags(['--path', '/a', 'example', '--path=/b']).get('path')).toBe(
      ['/a', '/b'].join(REPEATED_FLAG_SEPARATOR)
    )
  })

  it('preserves a trailing valueless flag for downstream validation', () => {
    expect(flags(['example', 'search', '--agent=a', '--agent']).get('agent')).toBe(true)
  })

  it('preserves the existing reset behavior when a valueless flag precedes more values', () => {
    expect(
      flags(['example', 'search', '--agent=a', '--agent', '--agent=b', '--agent=c']).get('agent')
    ).toBe(['b', 'c'].join(REPEATED_FLAG_SEPARATOR))
  })

  it('preserves empty values and equals signs without reinterpreting flag-like values', () => {
    expect(
      flags(['example', 'search', '--agent=', '--agent=--help', '--agent=a=b']).get('agent')
    ).toBe(['', '--help', 'a=b'].join(REPEATED_FLAG_SEPARATOR))
  })
})
