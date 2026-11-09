import { describe, expect, it } from 'vitest'

import type { CommandSpec } from './args'
import {
  REPEATED_FLAG_SEPARATOR,
  findCommandSpec,
  normalizeCommandPositionals,
  parseArgs,
  validateCommandAndFlags
} from './args'

describe('parseArgs', () => {
  it('keeps an empty string as a flag value', () => {
    const parsed = parseArgs(['computer', 'set-value', '--value', '', '--json'])

    expect(parsed.commandPath).toEqual(['computer', 'set-value'])
    expect(parsed.flags.get('value')).toBe('')
    expect(parsed.flags.get('json')).toBe(true)
  })

  it('accepts a flag value that starts with -- via the = form', () => {
    const parsed = parseArgs(['terminal', 'send', '--text=--help'])

    expect(parsed.commandPath).toEqual(['terminal', 'send'])
    expect(parsed.flags.get('text')).toBe('--help')
  })

  it('splits --flag=value on the first = so values may contain =', () => {
    const parsed = parseArgs(['set', 'cookie', '--value=a=b=c'])

    expect(parsed.flags.get('value')).toBe('a=b=c')
  })

  it('treats --flag= as an empty string value', () => {
    const parsed = parseArgs(['--value='])

    expect(parsed.flags.get('value')).toBe('')
  })

  it('does not consume a command token after an unknown flag', () => {
    const parsed = parseArgs(['--jso', 'worktree', 'list'], [['worktree', 'list']])

    expect(parsed.commandPath).toEqual(['worktree', 'list'])
    expect(parsed.flags.get('jso')).toBe(true)
  })

  it('does not consume a command token after a flag valid on another command', () => {
    const parsed = parseArgs(['--workspace', 'worktree', 'list'], [['worktree', 'list']])

    expect(parsed.commandPath).toEqual(['worktree', 'list'])
    expect(parsed.flags.get('workspace')).toBe(true)
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

  it('still consumes a pre-command flag value before a later command path', () => {
    const parsed = parseArgs(['--workspace', 'team-1', 'linear', 'list'], [['linear', 'list']])

    expect(parsed.commandPath).toEqual(['linear', 'list'])
    expect(parsed.flags.get('workspace')).toBe('team-1')
  })

  it('preserves existing pre-command selector values', () => {
    const parsed = parseArgs(['--repo', 'id:abc', 'worktree', 'list'], [['worktree', 'list']])

    expect(parsed.commandPath).toEqual(['worktree', 'list'])
    expect(parsed.flags.get('repo')).toBe('id:abc')
  })

  it('preserves a project selector before the project command', () => {
    const parsed = parseArgs(
      ['--project', 'github:stablyai/orca', 'project', 'setups'],
      [['project', 'setups']]
    )

    expect(parsed.commandPath).toEqual(['project', 'setups'])
    expect(parsed.flags.get('project')).toBe('github:stablyai/orca')
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

  it.each([
    ['--project', 'project', 'project', 'setups'],
    ['--project=project', 'project', 'setups']
  ])('preserves a command-named project selector in %j', (...args) => {
    const parsed = parseArgs(args, [['project', 'setups']])

    expect(parsed.commandPath).toEqual(['project', 'setups'])
    expect(parsed.flags.get('project')).toBe('project')
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

  it('preserves repeated string flags', () => {
    const parsed = parseArgs(['linear', 'label', 'add', '--label', 'Bug', '--label=Regression'])

    expect(parsed.flags.get('label')).toBe(`Bug${REPEATED_FLAG_SEPARATOR}Regression`)
  })

  it('does not apply repeated flag encoding to ordinary string flags', () => {
    const parsed = parseArgs(['linear', 'list', '--workspace', 'old', '--workspace', 'new'])

    expect(parsed.flags.get('workspace')).toBe('new')
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
    },
    {
      path: ['repo', 'show'],
      summary: 'Show a repo',
      usage: 'orca repo show --repo <selector>',
      allowedFlags: ['repo'],
      positionalArgs: ['repo']
    }
  ]

  it('resolves an aliased path to the canonical spec', () => {
    expect(findCommandSpec(specs, ['worktree', 'remove'])?.path).toEqual(['worktree', 'rm'])
  })

  it('canonicalizes an aliased command path during normalization', () => {
    const normalized = normalizeCommandPositionals(
      specs,
      parseArgs(['worktree', 'remove', '--force'])
    )

    expect(normalized.commandPath).toEqual(['worktree', 'rm'])
    expect(normalized.flags.get('force')).toBe(true)
  })

  it('binds a trailing positional after canonicalizing the base path', () => {
    const normalized = normalizeCommandPositionals(specs, parseArgs(['repo', 'show', 'id:abc']))

    expect(normalized.commandPath).toEqual(['repo', 'show'])
    expect(normalized.flags.get('repo')).toBe('id:abc')
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

  it('allows global runtime selector flags even when the command spec omits them', () => {
    const parsed = parseArgs([
      'demo',
      '--pairing-code',
      'remote-runtime',
      '--server',
      'build-box',
      '--json'
    ])

    expect(() => validateCommandAndFlags(specs, parsed)).not.toThrow()
  })

  it.each(['server', 'pairing-code'])('rejects --%s without a value', (flag) => {
    const parsed = parseArgs([`--${flag}`, 'demo'], [['demo']])

    expect(() => validateCommandAndFlags(specs, parsed)).toThrow(`Flag --${flag} requires a value.`)
  })

  it.each(['server', 'pairing-code'])('rejects an empty --%s= value', (flag) => {
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
