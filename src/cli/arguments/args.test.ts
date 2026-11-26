import { describe, expect, it } from 'vitest'

import { COMMAND_SPECS } from '../specs'
import { normalizeCommandPositionals, parseArgs, validateCommandAndFlags } from './args'

describe('parseArgs', () => {
  it.each([
    [['--focus', 'failing checks on my PRs'], 'failing checks on my PRs'],
    [['--focus', ''], ''],
    [['--focus=failing checks'], 'failing checks'],
    [['--focus', 'x', '--json'], 'x']
  ])('reads look-around set %j as focus text', (focusArgs, focus) => {
    const paths = COMMAND_SPECS.map((spec) => spec.path)
    const parsed = parseArgs(['bot', 'look-around', 'set', ...focusArgs], paths, COMMAND_SPECS)

    expect(parsed.commandPath).toEqual(['bot', 'look-around', 'set'])
    expect(parsed.flags.get('focus')).toBe(focus)
    expect(() => validateCommandAndFlags(COMMAND_SPECS, parsed)).not.toThrow()
  })

  it('reads --no-effects as a boolean on settling browser actions only', () => {
    const paths = COMMAND_SPECS.map((spec) => spec.path)
    const click = parseArgs(['click', '--no-effects', '--element', 'e3'], paths, COMMAND_SPECS)

    expect(click.flags.get('no-effects')).toBe(true)
    expect(click.flags.get('element')).toBe('e3')
    expect(() => validateCommandAndFlags(COMMAND_SPECS, click)).not.toThrow()

    const evaluate = parseArgs(['eval', '--expression', '1', '--no-effects'], paths, COMMAND_SPECS)
    expect(() => validateCommandAndFlags(COMMAND_SPECS, evaluate)).toThrow(/no-effects/)
  })

  it('preserves a selector value that is also a registered command', () => {
    const parsed = parseArgs(
      ['--environment', 'status', 'worktree', 'list'],
      [['status'], ['worktree', 'list']]
    )

    expect(parsed.commandPath).toEqual(['worktree', 'list'])
    expect(parsed.flags.get('environment')).toBe('status')
  })

  it('preserves a selector value that is also a command group', () => {
    const parsed = parseArgs(
      ['--environment', 'worktree', 'status'],
      [['status'], ['worktree', 'list']]
    )

    expect(parsed.commandPath).toEqual(['status'])
    expect(parsed.flags.get('environment')).toBe('worktree')
  })

  it('normalizes partial positionals without conflicting later flag-supplied args', () => {
    const parsed = normalizeCommandPositionals(
      [
        {
          path: ['emulator', 'permissions'],
          summary: 'Permissions',
          usage: 'orca emulator permissions <op> <package> [permission]',
          allowedFlags: ['op', 'package', 'permission'],
          positionalArgs: ['op', 'package', 'permission']
        }
      ],
      parseArgs([
        'emulator',
        'permissions',
        'grant',
        '--package',
        'com.example.app',
        '--permission',
        'android.permission.CAMERA'
      ])
    )

    expect(parsed.commandPath).toEqual(['emulator', 'permissions'])
    expect(parsed.flags.get('op')).toBe('grant')
    expect(parsed.flags.get('package')).toBe('com.example.app')
    expect(parsed.flags.get('permission')).toBe('android.permission.CAMERA')
    expect(parsed.positionalFlagConflicts).toEqual([])
  })
})
