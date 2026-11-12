import { describe, expect, it } from 'vitest'
import {
  parseArgs,
  validateCommandAndFlags,
  REPEATED_FLAG_SEPARATOR,
  specPaths,
  type CommandSpec
} from './args'

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

  it.each([
    ['--agent', '--agent=b'],
    ['--agent=a', '--agent', '--agent=b'],
    ['--agent=a', '--agent'],
    ['--agent', '--agent']
  ])('rejects a missing occurrence even among valid values: %j', (...options) => {
    const parsed = parseArgs(['example', 'search', ...options], paths, specs)
    expect(() => validateCommandAndFlags(specs, parsed)).toThrow('Flag --agent requires a value.')
  })

  it.each(['label', 'skill'])('also rejects erased missing legacy --%s values', (flag) => {
    const spec = { ...leaf, allowedFlags: [flag], repeatableFlags: [] }
    const parsed = parseArgs(['ex', 'find', `--${flag}=a`, `--${flag}`, `--${flag}=b`], paths, [
      spec
    ])
    expect(() => validateCommandAndFlags([spec], parsed)).toThrow(
      `Flag --${flag} requires a value.`
    )
  })

  it('preserves empty values and equals signs without reinterpreting flag-like values', () => {
    expect(
      flags(['example', 'search', '--agent=', '--agent=--help', '--agent=a=b']).get('agent')
    ).toBe(['', '--help', 'a=b'].join(REPEATED_FLAG_SEPARATOR))
  })
})
