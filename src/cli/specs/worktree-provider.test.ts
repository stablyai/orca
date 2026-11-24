import { describe, expect, it } from 'vitest'
import { findCommandSpec, normalizeCommandPositionals, parseArgs } from '../arguments/args'
import { specPaths } from '../discovery/command-spec'
import { COMMAND_SPECS } from './index'

const PATHS = COMMAND_SPECS.flatMap((spec) => specPaths(spec))

function parse(argv: string[]) {
  return normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv, PATHS, COMMAND_SPECS))
}

describe('worktree provider command specs', () => {
  it('maps the release positional selector to --worktree', () => {
    const parsed = parse(['worktree', 'release', 'id:repo-1::/slot', '--force'])
    expect(parsed.commandPath).toEqual(['worktree', 'release'])
    expect(parsed.flags.get('worktree')).toBe('id:repo-1::/slot')
    expect(parsed.flags.get('force')).toBe(true)
  })

  it('parses acquire flags and the providers subcommands', () => {
    const acquire = parse([
      'worktree',
      'acquire',
      '--provider',
      'wtp',
      '--repo',
      'path:/repo',
      '--profile',
      'cone',
      '--agent',
      'claude'
    ])
    expect(acquire.commandPath).toEqual(['worktree', 'acquire'])
    expect(acquire.flags.get('provider')).toBe('wtp')
    expect(acquire.flags.get('agent')).toBe('claude')

    expect(
      findCommandSpec(COMMAND_SPECS, ['worktree', 'providers', 'list'])?.allowedFlags
    ).toContain('repo')
    expect(findCommandSpec(COMMAND_SPECS, ['worktree', 'providers', 'trust'])?.path).toEqual([
      'worktree',
      'providers',
      'trust'
    ])
  })
})
