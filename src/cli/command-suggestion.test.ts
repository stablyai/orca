import { describe, expect, it } from 'vitest'

import type { CommandSpec } from './args'
import { levenshtein, suggestCommands, unknownCommandData } from './command-suggestion'

const specs: CommandSpec[] = [
  {
    path: ['worktree', 'rm'],
    aliases: [['worktree', 'remove']],
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
})
