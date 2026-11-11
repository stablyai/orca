import { describe, expect, it } from 'vitest'
import { parseArgs, validateCommandAndFlags } from '../args'
import { PROFILE_STATE_COMMAND_SPECS } from './profile-state'

describe('profile state rollback discovery', () => {
  it.each(
    ['current-json', 'latest-json'].flatMap((selector) => [
      { selector, argv: ['profile', 'state', 'rollback', `--${selector}`] },
      { selector, argv: [`--${selector}`, 'profile', 'state', 'rollback'] },
      { selector, argv: ['profile', `--${selector}`, 'state', 'rollback'] }
    ])
  )('parses the JSON selector as a boolean: $argv', ({ argv, selector }) => {
    const parsed = parseArgs(argv)
    expect(parsed.commandPath).toEqual(['profile', 'state', 'rollback'])
    expect(parsed.flags.get(selector)).toBe(true)
    expect(() => validateCommandAndFlags(PROFILE_STATE_COMMAND_SPECS, parsed)).not.toThrow()
  })

  it('parses the current SQLite selector as a boolean', () => {
    const parsed = parseArgs(['profile', 'state', 'rollback', '--current-sqlite'])
    expect(parsed.flags.get('current-sqlite')).toBe(true)
    expect(() => validateCommandAndFlags(PROFILE_STATE_COMMAND_SPECS, parsed)).not.toThrow()
  })
})
