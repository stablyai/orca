import { describe, expect, it } from 'vitest'

import type { CommandSpec } from './args'
import { levenshtein, suggestCommands, unknownCommandData } from './command-suggestion'

const specs: CommandSpec[] = [
  {
    path: ['worktree', 'rm'],
    aliases: [
      ['worktree', 'remove'],
      ['worktree', 'delete']
    ],
    destructive: true,
    summary: 'Remove a worktree',
    usage: 'orca worktree rm',
    allowedFlags: []
  },
  {
    path: ['worktree', 'list'],
    summary: 'List worktrees',
    usage: 'orca worktree list',
    allowedFlags: []
  },
  {
    path: ['terminal', 'send'],
    summary: 'Send input',
    usage: 'orca terminal send',
    allowedFlags: []
  },
  {
    // A destructive command outside the delete-family, to prove the guard keys
    // off the spec flag rather than a hardcoded verb list.
    path: ['emulator', 'kill'],
    destructive: true,
    summary: 'Kill the emulator',
    usage: 'orca emulator kill',
    allowedFlags: []
  }
]

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('rm', 'rm')).toBe(0)
  })

  it('counts single-edit distance', () => {
    expect(levenshtein('remov', 'remove')).toBe(1)
  })

  it('handles empty operands', () => {
    expect(levenshtein('', 'abc')).toBe(3)
    expect(levenshtein('abc', '')).toBe(3)
  })
})

describe('suggestCommands', () => {
  it('suggests the closest command for a near-miss verb', () => {
    expect(suggestCommands(specs, ['worktree', 'remov'])).toContain('worktree rm')
  })

  it('includes alias paths among suggestions', () => {
    // `worktree remove` is the alias; a typo near it should surface it (an exact
    // match would resolve as a real command, not trigger a suggestion).
    expect(suggestCommands(specs, ['worktree', 'remov'])).toContain('worktree remove')
  })

  it('returns nothing for a wildly-off token', () => {
    expect(suggestCommands(specs, ['worktree', 'zzzzz'])).toEqual([])
  })

  it('only considers commands of the same depth', () => {
    expect(suggestCommands(specs, ['worktree', 'list', 'extra'])).toEqual([])
  })

  it('suggests a top-level command group near-miss', () => {
    expect(suggestCommands(specs, ['worktre'])).toEqual(['worktree'])
  })

  it('ranks closer matches first', () => {
    const result = suggestCommands(specs, ['terminal', 'sen'])
    expect(result[0]).toBe('terminal send')
  })

  it('never suggests a destructive command for a benign non-destructive typo', () => {
    // `worktree move` sits distance 2 from `worktree remove`; without the
    // guard it would sole-suggest an irreversible delete on blind retry. #6303
    const result = suggestCommands(specs, ['worktree', 'move'])
    expect(result).not.toContain('worktree remove')
    expect(result).not.toContain('worktree rm')
    expect(result).not.toContain('worktree delete')
  })

  it('still suggests remove for a near-miss of a destructive verb', () => {
    const result = suggestCommands(specs, ['worktree', 'remov'])
    expect(result).toContain('worktree rm')
    expect(result).toContain('worktree remove')
  })

  it('still suggests delete for a near-miss of the delete alias', () => {
    expect(suggestCommands(specs, ['worktree', 'delet'])).toContain('worktree delete')
  })

  it('guards destructive commands outside the delete-family via the spec flag', () => {
    // `emulator ball` is a benign token, distance 2 from the flagged `emulator
    // kill` — close enough to otherwise rank, so the guard must exclude it.
    expect(suggestCommands(specs, ['emulator', 'ball'])).not.toContain('emulator kill')
    // A genuine near-miss of the destructive verb still recovers.
    expect(suggestCommands(specs, ['emulator', 'kil'])).toContain('emulator kill')
  })

  it('still recovers non-destructive near-misses', () => {
    expect(suggestCommands(specs, ['worktree', 'lst'])).toContain('worktree list')
  })
})

describe('unknownCommandData', () => {
  it('produces a human nextSteps line when a suggestion exists', () => {
    const data = unknownCommandData(specs, ['worktree', 'remov'])
    expect(data.suggestions).toContain('worktree rm')
    expect(data.nextSteps[0]).toContain('Did you mean')
    expect(data.nextSteps[0]).toContain('orca worktree rm')
  })

  it('produces empty nextSteps when nothing is close', () => {
    const data = unknownCommandData(specs, ['worktree', 'zzzzz'])
    expect(data.suggestions).toEqual([])
    expect(data.nextSteps).toEqual([])
  })

  it('does not route a benign typo into a destructive nextStep', () => {
    const data = unknownCommandData(specs, ['worktree', 'move'])
    expect(data.suggestions).not.toContain('worktree remove')
    expect(data.nextSteps.join(' ')).not.toContain('remove')
  })
})
