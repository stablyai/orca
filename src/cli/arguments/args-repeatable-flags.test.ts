import { describe, expect, it } from 'vitest'
import { parseArgs, validateCommandAndFlags } from './args'
import { specPaths, type CommandSpec } from '../discovery/command-spec'

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

describe('command-scoped repeatable flags', () => {
  it.each([['--agent=a', '--agent', '--agent=b']])(
    'rejects a missing occurrence even among valid values: %j',
    (...options) => {
      const parsed = parseArgs(['example', 'search', ...options], paths, specs)
      expect(() => validateCommandAndFlags(specs, parsed)).toThrow('Flag --agent requires a value.')
    }
  )
})
