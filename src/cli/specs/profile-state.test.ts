import { describe, expect, it } from 'vitest'
import { findCommandSpec, parseArgs, validateCommandAndFlags } from '../args'
import { formatCommandHelp } from '../help'
import { PROFILE_STATE_COMMAND_SPECS } from './profile-state'

describe('profile state rollback discovery', () => {
  it.each(['exports', 'rollback'])('accepts an explicit profile for %s', (command) => {
    const parsed = parseArgs(['profile', 'state', command, '--profile-id', 'inactive'])
    expect(parsed.flags.get('profile-id')).toBe('inactive')
    expect(() => validateCommandAndFlags(PROFILE_STATE_COMMAND_SPECS, parsed)).not.toThrow()
  })
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

  it('renders rollback help explaining state selection and archival', () => {
    const spec = findCommandSpec(PROFILE_STATE_COMMAND_SPECS, ['profile', 'state', 'rollback'])
    if (!spec) {
      throw new Error('Missing profile state rollback spec')
    }
    const help = formatCommandHelp(spec)

    expect(help).toContain('--current-json')
    expect(help).toContain('without merging; both copies are archived')
    expect(help).toContain('$ orca profile state rollback --current-json')
    expect(help).toContain('--latest-json')
    expect(help).toContain('exports the latest SQLite state')
    expect(help).toContain('$ orca profile state rollback --latest-json')
  })
})
