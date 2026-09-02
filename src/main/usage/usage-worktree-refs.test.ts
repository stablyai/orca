import { describe, expect, it } from 'vitest'
import type { UsageWorktreeRef } from '../usage-worktree-metadata'
import { getUsageWorktreeFingerprint } from './usage-worktree-refs'

function worktree(worktreeId: string, path: string, displayName: string): UsageWorktreeRef {
  return { worktreeId, path, displayName }
}

describe('getUsageWorktreeFingerprint', () => {
  it('is stable across repo and worktree ordering but changes with identity metadata', () => {
    const first = new Map<string, UsageWorktreeRef[]>([
      [
        'repo-b',
        [
          worktree('repo-b::/repo/b-two', '/repo/b-two', 'B Two'),
          worktree('repo-b::/repo/b-one', '/repo/b-one', 'B One')
        ]
      ],
      ['repo-a', [worktree('repo-a::/repo/a', '/repo/a', 'A')]]
    ])
    const reordered = new Map<string, UsageWorktreeRef[]>([
      ['repo-a', [worktree('repo-a::/repo/a', '/repo/a', 'A')]],
      [
        'repo-b',
        [
          worktree('repo-b::/repo/b-one', '/repo/b-one', 'B One'),
          worktree('repo-b::/repo/b-two', '/repo/b-two', 'B Two')
        ]
      ]
    ])
    const renamed = new Map(reordered)
    renamed.set('repo-a', [worktree('repo-a::/repo/a', '/repo/a', 'Renamed A')])

    expect(getUsageWorktreeFingerprint(first)).toBe(getUsageWorktreeFingerprint(reordered))
    expect(getUsageWorktreeFingerprint(renamed)).not.toBe(getUsageWorktreeFingerprint(first))
  })
})
