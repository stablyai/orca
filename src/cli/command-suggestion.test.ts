import { describe, expect, it } from 'vitest'

import type { CommandSpec } from './args'
import { suggestCommands, unknownCommandData } from './command-suggestion'
import { COMMAND_SPECS } from './specs'
import { ORCHESTRATION_COMMAND_SPECS } from './specs/orchestration'

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
    path: ['orchestration', 'reset'],
    destructive: true,
    summary: 'Reset orchestration state',
    usage: 'orca orchestration reset',
    allowedFlags: []
  },
  {
    path: ['artifacts', 'delete'],
    destructive: true,
    summary: 'Delete an artifact',
    usage: 'orca artifacts delete',
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

describe.each([
  { name: 'orchestration registry', specs: ORCHESTRATION_COMMAND_SPECS },
  { name: 'full CLI registry', specs: COMMAND_SPECS }
])('$name reset suggestion safety', ({ specs }) => {
  it.each(['resume', 'rerun', 'repl'])('does not suggest reset for %s', (verb) => {
    const data = unknownCommandData(specs, ['orchestration', verb])

    expect(data.suggestions).not.toContain('orchestration reset')
    expect(data.nextSteps.join('\n')).not.toContain('orca orchestration reset')
  })

  it.each(['rese', 'rest'])('still recovers the near-miss %s', (verb) => {
    const data = unknownCommandData(specs, ['orchestration', verb])

    expect(data.suggestions).toContain('orchestration reset')
    expect(data.nextSteps.join('\n')).toContain('orca orchestration reset')
  })

  it('preserves non-destructive check recovery', () => {
    const data = unknownCommandData(specs, ['orchestration', 'chek'])

    expect(data.suggestions).toContain('orchestration check')
    expect(data.nextSteps.join('\n')).toContain('orca orchestration check')
    expect(data.suggestions).not.toContain('orchestration reset')
    expect(data.nextSteps.join('\n')).not.toContain('orca orchestration reset')
  })
})

describe.each([
  { name: 'isolated registry', specs },
  { name: 'full CLI registry', specs: COMMAND_SPECS }
])('$name destructive command isolation', ({ specs }) => {
  it('does not unlock delete for a near-miss of reset', () => {
    const data = unknownCommandData(specs, ['artifacts', 'deset'])

    expect(data.suggestions).not.toContain('artifacts delete')
    expect(data.nextSteps.join('\n')).not.toContain('orca artifacts delete')
  })

  it('still recovers a near-miss of delete itself', () => {
    const data = unknownCommandData(specs, ['artifacts', 'delet'])

    expect(data.suggestions).toContain('artifacts delete')
    expect(data.nextSteps.join('\n')).toContain('orca artifacts delete')
  })
})
