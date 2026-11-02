import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sortWorktrees, type Worktree } from './workspace-list-sections'
import { hostSortsByStamps } from './workspace-list-ordering'

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  const worktreePath = join('/tmp', 'orca', 'worktrees', 'feature')
  return {
    workspaceKind: 'git',
    worktreeId: `repo-1::${worktreePath}`,
    repoId: 'repo-1',
    repo: 'orca',
    branch: 'feature/mobile-parity',
    displayName: 'feature',
    path: worktreePath,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null,
    status: 'inactive',
    agents: [],
    ...overrides
  }
}

describe('sortWorktrees with host stamps', () => {
  it('sorts by the host’s stamps when it writes them, with no output or saved ranks', () => {
    const rest = worktree({
      worktreeId: 'rest',
      displayName: 'A',
      lastActivityAt: 900,
      lastOutputAt: 5_000,
      sortOrder: 9,
      sortedByStamps: true
    })
    const done = worktree({
      worktreeId: 'done',
      displayName: 'B',
      lastActivityAt: 10,
      smartTier: 'done',
      smartAt: 20,
      unread: true,
      sortedByStamps: true
    })
    const needsYou = worktree({
      worktreeId: 'needs-you',
      displayName: 'C',
      lastActivityAt: 5,
      smartTier: 'needs-you',
      smartAt: 1,
      sortedByStamps: true
    })
    // A row from an older paired server writes no tier: it rests by Recent among them.
    const older = worktree({ worktreeId: 'older', displayName: 'D', lastActivityAt: 950 })
    const rows = [rest, done, needsYou, older]
    expect(sortWorktrees(rows, 'smart').map((item) => item.worktreeId)).toEqual([
      'needs-you',
      'done',
      'older',
      'rest'
    ])
    expect(sortWorktrees(rows, 'recent').map((item) => item.worktreeId)).toEqual([
      'older',
      'rest',
      'done',
      'needs-you'
    ])
  })

  it('keeps the host’s order when a filter leaves only an older server’s rows', () => {
    const stamped = worktree({ worktreeId: 'stamped', lastActivityAt: 1, sortedByStamps: true })
    const quiet = worktree({ worktreeId: 'quiet', displayName: 'A', lastActivityAt: 10 })
    const busy = worktree({
      worktreeId: 'busy',
      displayName: 'B',
      lastActivityAt: 5,
      createdAt: 0
    })
    const all = [stamped, quiet, busy]
    const order = (rows: Worktree[]) =>
      sortWorktrees(rows, 'recent', 0, hostSortsByStamps(all)).map((item) => item.worktreeId)
    expect(order([quiet, busy])).toEqual(['quiet', 'busy'])
    // Without the host's answer the phone applies the new-workspace grace.
    expect(sortWorktrees([quiet, busy], 'recent', 0).map((item) => item.worktreeId)).toEqual([
      'busy',
      'quiet'
    ])
  })

  it('a Done the user has seen rests by Recent (owner decision Q1)', () => {
    const seen = worktree({
      worktreeId: 'seen',
      displayName: 'A',
      lastActivityAt: 30,
      smartTier: 'done',
      smartAt: 30,
      unread: false,
      sortedByStamps: true
    })
    const working = worktree({
      worktreeId: 'working',
      displayName: 'B',
      lastActivityAt: 1,
      smartTier: 'working',
      smartAt: 1,
      sortedByStamps: true
    })
    expect(sortWorktrees([seen, working], 'smart').map((item) => item.worktreeId)).toEqual([
      'working',
      'seen'
    ])
  })
})
