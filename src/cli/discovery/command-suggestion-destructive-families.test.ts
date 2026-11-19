import { describe, expect, it } from 'vitest'
import type { CommandSpec } from './command-spec'
import { suggestCommands } from './command-suggestion'

function destructiveSpec(path: string[], aliases?: string[][]): CommandSpec {
  return { path, aliases, destructive: true, summary: '', usage: '', allowedFlags: [] }
}

describe('declared destructive alias families', () => {
  const deletion = destructiveSpec(
    ['worktree', 'rm'],
    [
      ['worktree', 'remove'],
      ['worktree', 'delete']
    ]
  )
  const reset = destructiveSpec(['orchestration', 'reset'])

  it('does not let intent for reset unlock a deletion candidate', () => {
    const specs = [deletion, reset, destructiveSpec(['artifacts', 'delete'])]
    expect(suggestCommands(specs, ['artifacts', 'deset'])).toEqual([])
  })

  it('shares only declared equivalent verbs with another command', () => {
    const specs = [deletion, reset, destructiveSpec(['environment', 'rm'])]
    expect(suggestCommands(specs, ['environment', 'remov'])).toEqual(['environment rm'])
    expect(suggestCommands(specs, ['environment', 'rese'])).toEqual([])
  })

  it('merges overlapping declarations transitively regardless of registry order', () => {
    const specs = [
      destructiveSpec(['one', 'read'], [['one', 'redo']]),
      destructiveSpec(['two', 'redo'], [['two', 'undo']]),
      destructiveSpec(['three', 'undo'])
    ]
    expect(suggestCommands(specs, ['three', 'red'])).toEqual(['three undo'])
    expect(suggestCommands(specs.toReversed(), ['three', 'red'])).toEqual(['three undo'])
  })

  it('does not derive destructive equivalence from ordinary command aliases', () => {
    const specs: CommandSpec[] = [
      destructiveSpec(['state', 'undo']),
      {
        path: ['inspect', 'read'],
        aliases: [['inspect', 'undo']],
        summary: '',
        usage: '',
        allowedFlags: []
      }
    ]
    expect(suggestCommands(specs, ['state', 'red'])).toEqual([])
  })

  it('keeps ranking, deduplication, depth, and the three-result limit', () => {
    const specs = [
      destructiveSpec(['state', 'reset']),
      ...['rest', 'resee', 'reses', 'resets'].map((verb) => ({
        path: ['state', verb],
        summary: '',
        usage: '',
        allowedFlags: []
      })),
      { path: ['state', 'rest'], summary: '', usage: '', allowedFlags: [] },
      { ...destructiveSpec(['state', 'rese']), hidden: true }
    ]
    expect(suggestCommands(specs, ['state', 'rese'])).toEqual([
      'state resee',
      'state reses',
      'state reset'
    ])
    expect(suggestCommands(specs, ['state', 'rese', 'extra'])).toEqual([])
  })
})
