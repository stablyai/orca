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

  it('explains that adoption selects one full state and preserves both copies', () => {
    const spec = PROFILE_STATE_COMMAND_SPECS.find((item) => item.path.at(-1) === 'rollback')
    expect(spec?.usage).toContain('--current-json')
    expect(spec?.notes?.join('\n')).toContain('without merging; both copies are archived')
    expect(spec?.examples).toContain('orca profile state rollback --current-json')
    expect(spec?.usage).toContain('--latest-json')
    expect(spec?.notes?.join('\n')).toContain('exports the latest SQLite state')
    expect(spec?.examples).toContain('orca profile state rollback --latest-json')
  })
})
