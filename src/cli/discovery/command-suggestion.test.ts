import { describe, expect, it } from 'vitest'

import type { CommandSpec } from './command-spec'
import { suggestCommands } from './command-suggestion'

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
  it('never suggests a destructive command for a benign non-destructive typo', () => {
    const result = suggestCommands(specs, ['worktree', 'move'])
    expect(result).not.toContain('worktree remove')
    expect(result).not.toContain('worktree rm')
    expect(result).not.toContain('worktree delete')
  })

  it('guards destructive commands outside the delete-family via the spec flag', () => {
    expect(suggestCommands(specs, ['emulator', 'ball'])).not.toContain('emulator kill')
    expect(suggestCommands(specs, ['emulator', 'kil'])).toContain('emulator kill')
  })
})
