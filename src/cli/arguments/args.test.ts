import { describe, expect, it } from 'vitest'

import type { CommandSpec } from '../discovery/command-spec'
import { normalizeCommandPositionals, parseArgs } from './args'

describe('parseArgs', () => {
  it('lets a command take a number after a globally boolean flag (secret request --wait 300)', () => {
    const specs = [
      {
        path: ['secret', 'request'],
        summary: '',
        usage: '',
        allowedFlags: ['reason', 'wait'],
        positionalArgs: ['name'],
        optionalNumberFlags: ['wait']
      },
      { path: ['cloud', 'env', 'build'], summary: '', usage: '', allowedFlags: ['wait'] }
    ] satisfies CommandSpec[]
    const paths = specs.map((spec) => spec.path)
    const waited = parseArgs(
      ['secret', 'request', 'NPM_TOKEN', '--reason', 'x', '--wait', '300'],
      paths,
      specs
    )
    expect(waited.commandPath).toEqual(['secret', 'request', 'NPM_TOKEN'])
    expect(waited.flags.get('wait')).toBe('300')
    const bare = parseArgs(['secret', 'request', 'NPM_TOKEN', '--wait', '--json'], paths, specs)
    expect(bare.flags.get('wait')).toBe(true)
    // Other commands keep --wait boolean: a following number stays positional.
    const other = parseArgs(['cloud', 'env', 'build', '--wait', '5'], paths, specs)
    expect(other.flags.get('wait')).toBe(true)
    expect(other.commandPath).toEqual(['cloud', 'env', 'build', '5'])
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
