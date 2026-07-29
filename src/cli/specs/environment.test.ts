import { describe, expect, it } from 'vitest'

import { parseArgs, validateCommandAndFlags } from '../args'
import { ENVIRONMENT_COMMAND_SPECS } from './environment'

describe('environment command specs', () => {
  it('accepts --endpoint on environment add and carries its value through', () => {
    const parsed = parseArgs([
      'environment',
      'add',
      '--name',
      'work-laptop',
      '--pairing-code',
      'orca://pair?code=abc',
      '--endpoint',
      '100.64.0.2'
    ])

    expect(() => validateCommandAndFlags(ENVIRONMENT_COMMAND_SPECS, parsed)).not.toThrow()
    expect(parsed.flags.get('endpoint')).toBe('100.64.0.2')
  })

  // Why: only GLOBAL_VALUE_FLAGS get the parse-time "requires a value" guard, so
  // an empty --endpoint reaches the handler; rejection is asserted there instead.
  it('parses an empty --endpoint= into an empty value rather than dropping the flag', () => {
    const parsed = parseArgs(['environment', 'add', '--endpoint='])

    expect(() => validateCommandAndFlags(ENVIRONMENT_COMMAND_SPECS, parsed)).not.toThrow()
    expect(parsed.flags.get('endpoint')).toBe('')
  })

  it('rejects --endpoint on commands that do not resolve an address', () => {
    for (const path of [
      ['environment', 'list'],
      ['environment', 'show', '--environment', 'work-laptop'],
      ['environment', 'rm', '--environment', 'work-laptop']
    ]) {
      const parsed = parseArgs([...path, '--endpoint', '100.64.0.2'])
      expect(() => validateCommandAndFlags(ENVIRONMENT_COMMAND_SPECS, parsed)).toThrow(
        /Unknown flag --endpoint/
      )
    }
  })
})
