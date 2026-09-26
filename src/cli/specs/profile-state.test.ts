import { describe, expect, it } from 'vitest'
import { parseArgs, validateCommandAndFlags } from '../args'
import { PROFILE_STATE_COMMAND_SPECS } from './profile-state'

describe('profile state rollback discovery', () => {
  it.each([
    { argv: ['profile', 'state', 'rollback', '--current-json'] },
    { argv: ['--current-json', 'profile', 'state', 'rollback'] },
    { argv: ['profile', '--current-json', 'state', 'rollback'] }
  ])('parses the current JSON selector as a boolean: $argv', ({ argv }) => {
    const parsed = parseArgs(argv)
    expect(parsed.commandPath).toEqual(['profile', 'state', 'rollback'])
    expect(parsed.flags.get('current-json')).toBe(true)
    expect(() => validateCommandAndFlags(PROFILE_STATE_COMMAND_SPECS, parsed)).not.toThrow()
  })

  it('explains that adoption selects one full state and preserves both copies', () => {
    const spec = PROFILE_STATE_COMMAND_SPECS.find((item) => item.path.at(-1) === 'rollback')
    expect(spec?.usage).toContain('--current-json')
    expect(spec?.notes?.join('\n')).toContain('without merging; both copies are archived')
    expect(spec?.examples).toContain('orca profile state rollback --current-json')
  })
})
