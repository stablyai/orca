import { describe, expect, it } from 'vitest'

import type { CommandSpec } from './args'
import {
  REPEATED_FLAG_SEPARATOR,
  findCommandSpec,
  normalizeCommandPositionals,
  parseArgs,
  supportsBrowserPageFlag,
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

  it('still parses boolean flags and space-separated values', () => {
    const parsed = parseArgs(['tab', 'create', '--json', '--url', 'https://example.com'])

    expect(parsed.commandPath).toEqual(['tab', 'create'])
    expect(parsed.flags.get('json')).toBe(true)
    expect(parsed.flags.get('url')).toBe('https://example.com')
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

  it('parses emulator reinstall as a boolean flag', () => {
    const parsed = parseArgs(['emulator', 'install', 'app.apk', '--reinstall', '--device', 'emu'])

    expect(parsed.commandPath).toEqual(['emulator', 'install', 'app.apk'])
    expect(parsed.flags.get('reinstall')).toBe(true)
    expect(parsed.flags.get('device')).toBe('emu')
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

  it('resolves an exact canonical path to its spec', () => {
    expect(findCommandSpec(specs, ['worktree', 'rm'])?.path).toEqual(['worktree', 'rm'])
  })

  it('resolves an aliased path to the canonical spec', () => {
    expect(findCommandSpec(specs, ['worktree', 'remove'])?.path).toEqual(['worktree', 'rm'])
  })

  it('resolves each declared alias to the canonical spec', () => {
    expect(findCommandSpec(specs, ['worktree', 'delete'])?.path).toEqual(['worktree', 'rm'])
  })

  it('returns undefined for a path matching neither canonical nor alias', () => {
    expect(findCommandSpec(specs, ['worktree', 'destroy'])).toBeUndefined()
  })

  it('canonicalizes an aliased command path during normalization', () => {
    const normalized = normalizeCommandPositionals(
      specs,
      parseArgs(['worktree', 'remove', '--force'])
    )

    expect(normalized.commandPath).toEqual(['worktree', 'rm'])
    expect(normalized.flags.get('force')).toBe(true)
  })

  it('leaves a canonical command path unchanged during normalization', () => {
    const normalized = normalizeCommandPositionals(specs, parseArgs(['worktree', 'rm']))

    expect(normalized.commandPath).toEqual(['worktree', 'rm'])
  })

  it('binds a trailing positional after canonicalizing the base path', () => {
    const normalized = normalizeCommandPositionals(specs, parseArgs(['repo', 'show', 'id:abc']))

    expect(normalized.commandPath).toEqual(['repo', 'show'])
    expect(normalized.flags.get('repo')).toBe('id:abc')
  })
})

describe('supportsBrowserPageFlag', () => {
  it('does not expose browser page targeting on orchestration commands', () => {
    expect(supportsBrowserPageFlag(['orchestration', 'send'])).toBe(false)
  })

  it('does not expose browser page targeting on local agent discovery', () => {
    expect(supportsBrowserPageFlag(['agent-context'])).toBe(false)
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
      '--environment',
      'server',
      '--json'
    ])

    expect(() => validateCommandAndFlags(specs, parsed)).not.toThrow()
  })

  it.each(['environment', 'pairing-code'])('rejects --%s without a value', (flag) => {
    const parsed = parseArgs([`--${flag}`, 'demo'], [['demo']])

    expect(() => validateCommandAndFlags(specs, parsed)).toThrow(`Flag --${flag} requires a value.`)
  })

  it.each(['environment', 'pairing-code'])('rejects an empty --%s= value', (flag) => {
    const parsed = parseArgs(['demo', `--${flag}=`])

    expect(() => validateCommandAndFlags(specs, parsed)).toThrow(`Flag --${flag} requires a value.`)
  })

  it('still rejects unknown command-specific flags', () => {
    const parsed = parseArgs(['demo', '--bogus'])

    expect(() => validateCommandAndFlags(specs, parsed)).toThrow(
      'Unknown flag --bogus for command: demo'
    )
  })

  it('enumerates valid flags and suggests a near-miss on unknown-flag errors', () => {
    const flagSpecs: CommandSpec[] = [
      {
        path: ['worktree', 'rm'],
        summary: 'Remove a worktree',
        usage: 'orca worktree rm',
        allowedFlags: ['worktree', 'force', 'run-hooks']
      }
    ]
    const parsed = parseArgs(['worktree', 'rm', '--forcce'])

    try {
      validateCommandAndFlags(flagSpecs, parsed)
      throw new Error('expected validateCommandAndFlags to throw')
    } catch (error) {
      const data = (error as { data?: { validFlags: string[]; nextSteps: string[] } }).data
      expect(data?.validFlags).toContain('force')
      expect(data?.validFlags).toContain('json')
      expect(data?.nextSteps.join('\n')).toContain('--force')
      expect(data?.nextSteps.join('\n')).toContain('Valid flags:')
    }
  })

  it('attaches did-you-mean suggestions to unknown-command errors', () => {
    const suggestSpecs: CommandSpec[] = [
      {
        path: ['worktree', 'rm'],
        summary: 'Remove a worktree',
        usage: 'orca worktree rm',
        allowedFlags: []
      }
    ]
    const parsed = parseArgs(['worktree', 'remov'])

    try {
      validateCommandAndFlags(suggestSpecs, parsed)
      throw new Error('expected validateCommandAndFlags to throw')
    } catch (error) {
      const data = (error as { data?: { suggestions: string[]; nextSteps: string[] } }).data
      expect(data?.suggestions).toContain('worktree rm')
      expect(data?.nextSteps[0]).toContain('orca worktree rm')
    }
  })
})
