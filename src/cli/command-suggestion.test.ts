import { describe, expect, it } from 'vitest'

import type { CommandSpec } from './args'
import { suggestCommands, unknownCommandData } from './command-suggestion'

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
  },
  {
    path: ['terminal', 'stop'],
    hidden: true,
    summary: 'Deprecated terminal stop',
    usage: 'orca terminal stop',
    allowedFlags: []
  }
]

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

  it('does not suggest hidden compatibility commands', () => {
    expect(suggestCommands(specs, ['terminal', 'stp'])).not.toContain('terminal stop')
  })

  it('still recovers a near miss when operands follow it', () => {
    expect(suggestCommands(specs, ['terminal', 'sen', 'hello'])).toEqual(['terminal send'])
  })

  it('judges destructive intent at the verb, not at a trailing operand', () => {
    expect(suggestCommands(specs, ['worktree', 'remov', 'feature'])).toContain('worktree rm')
    expect(suggestCommands(specs, ['worktree', 'move', 'remove'])).not.toContain('worktree rm')
  })
})

describe('suggestCommands for grouped top-level commands', () => {
  const grouped: CommandSpec[] = [
    { path: ['page', 'identity'], summary: '', usage: '', allowedFlags: [] },
    { path: ['goto'], group: 'page', summary: '', usage: '', allowedFlags: [] },
    { path: ['tab', 'create'], group: 'page', summary: '', usage: '', allowedFlags: [] },
    {
      path: ['cookie', 'delete'],
      group: 'page',
      destructive: true,
      summary: '',
      usage: '',
      allowedFlags: []
    },
    { path: ['worktree', 'list'], summary: '', usage: '', allowedFlags: [] }
  ]

  it('recovers a group-prefixed guess to the top-level command', () => {
    expect(suggestCommands(grouped, ['page', 'goto', 'https://example.com'])).toEqual(['goto'])
    expect(suggestCommands(grouped, ['page', 'tab', 'creat'])).toEqual(['tab create'])
  })

  it('maps an open/navigate rename to the real verb', () => {
    expect(suggestCommands(grouped, ['page', 'open', 'https://example.com'])).toEqual([
      'tab create'
    ])
    expect(suggestCommands(grouped, ['navigate', 'https://example.com'])).toEqual(['goto'])
  })

  it('keeps the destructive guard on group-prefixed candidates', () => {
    expect(suggestCommands(grouped, ['page', 'cookie', 'delete'])).toEqual(['cookie delete'])
    expect(suggestCommands(grouped, ['page', 'cookie', 'select'])).not.toContain('cookie delete')
  })

  it('does not offer group members under an unrelated group', () => {
    expect(suggestCommands(grouped, ['worktree', 'goto'])).toEqual([])
  })

  it('adds the group-help pointer only under a group with top-level members', () => {
    expect(unknownCommandData(grouped, ['page', 'zzzzzz']).nextSteps).toEqual([
      "Orca's page commands run at the top level (orca <command>, not orca page <command>); list them with: orca page --help"
    ])
    expect(unknownCommandData(grouped, ['worktree', 'zzzzzz']).nextSteps).toEqual([])
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
