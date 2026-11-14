import { describe, expect, it } from 'vitest'

import type { CommandSpec } from '../discovery/command-spec'
import { normalizeCommandPositionals, parseArgs, validateCommandAndFlags } from './args'

describe('parseArgs', () => {
  it('keeps an empty string as a flag value', () => {
    const parsed = parseArgs(['computer', 'set-value', '--value', '', '--json'])

    expect(parsed.commandPath).toEqual(['computer', 'set-value'])
    expect(parsed.flags.get('value')).toBe('')
    expect(parsed.flags.get('json')).toBe(true)
  })

  it('splits --flag=value on the first = so values may contain =', () => {
    const parsed = parseArgs(['set', 'cookie', '--value=a=b=c'])

    expect(parsed.flags.get('value')).toBe('a=b=c')
  })

  it('recognizes a command path with a boolean flag between its segments', () => {
    const parsed = parseArgs(['--jso', 'worktree', '--json', 'list'], [['worktree', 'list']])

    expect(parsed.commandPath).toEqual(['worktree', 'list'])
    expect(parsed.flags.get('jso')).toBe(true)
    expect(parsed.flags.get('json')).toBe(true)
  })

  it('recognizes a command path with a value flag between its segments', () => {
    const parsed = parseArgs(
      ['--jso', 'worktree', '--repo', 'id:abc', 'list'],
      [['worktree', 'list']]
    )

    expect(parsed.commandPath).toEqual(['worktree', 'list'])
    expect(parsed.flags.get('jso')).toBe(true)
    expect(parsed.flags.get('repo')).toBe('id:abc')
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

describe('command aliases', () => {
  const specs: CommandSpec[] = [
    {
      path: ['worktree', 'rm'],
      aliases: [
        ['worktree', 'remove'],
        ['worktree', 'delete']
      ],
      summary: 'Remove a worktree',
      usage: 'orca worktree rm --worktree <selector>',
      allowedFlags: ['worktree', 'force']
    }
  ]

  it('canonicalizes an aliased command path during normalization', () => {
    const normalized = normalizeCommandPositionals(
      specs,
      parseArgs(['worktree', 'remove', '--force'])
    )

    expect(normalized.commandPath).toEqual(['worktree', 'rm'])
    expect(normalized.flags.get('force')).toBe(true)
  })
})

describe('validateCommandAndFlags', () => {
  const specs = [
    {
      path: ['demo'],
      summary: 'Demo command',
      usage: 'orca demo',
      allowedFlags: []
    }
  ]

  it.each(['environment'])('rejects --%s without a value', (flag) => {
    const parsed = parseArgs([`--${flag}`, 'demo'], [['demo']])

    expect(() => validateCommandAndFlags(specs, parsed)).toThrow(`Flag --${flag} requires a value.`)
  })

  it.each(['environment'])('rejects an empty --%s= value', (flag) => {
    const parsed = parseArgs(['demo', `--${flag}=`])

    expect(() => validateCommandAndFlags(specs, parsed)).toThrow(`Flag --${flag} requires a value.`)
  })

  it('still rejects unknown command-specific flags', () => {
    const parsed = parseArgs(['demo', '--bogus'])

    expect(() => validateCommandAndFlags(specs, parsed)).toThrow(
      'Unknown flag --bogus for command: demo'
    )
  })
})
