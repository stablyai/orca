import { describe, expect, it } from 'vitest'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { planRepoRelinkWorktreeMoves } from './repo-relink-worktree-moves'

function worktree(path: string, isMainWorktree = false): GitWorktreeInfo {
  return { path, head: 'abc', branch: 'refs/heads/x', isBare: false, isMainWorktree }
}

describe('planRepoRelinkWorktreeMoves', () => {
  it('moves the main worktree even when Orca holds no state for it yet', () => {
    expect(
      planRepoRelinkWorktreeMoves({
        repoId: 'r',
        oldPath: '/old/app',
        newPath: '/new/app',
        knownWorktreeIds: [],
        gitWorktrees: []
      })
    ).toEqual({
      moves: [{ oldWorktreeId: 'r::/old/app', newWorktreeId: 'r::/new/app' }],
      staleLinkedWorktreeIds: []
    })
  })

  it('moves a nested linked worktree only when git lists it at the new location', () => {
    const plan = planRepoRelinkWorktreeMoves({
      repoId: 'r',
      oldPath: '/old/app',
      newPath: '/new/app',
      knownWorktreeIds: [
        'r::/old/app',
        'r::/old/app/.worktrees/listed',
        'r::/old/app/.worktrees/stale',
        'r::/elsewhere/feature',
        'other::/old/app'
      ],
      gitWorktrees: [
        worktree('/new/app', true),
        worktree('/new/app/.worktrees/listed'),
        worktree('/old/app/.worktrees/stale'),
        worktree('/elsewhere/feature')
      ]
    })
    expect(plan.moves).toEqual([
      { oldWorktreeId: 'r::/old/app', newWorktreeId: 'r::/new/app' },
      {
        oldWorktreeId: 'r::/old/app/.worktrees/listed',
        newWorktreeId: 'r::/new/app/.worktrees/listed'
      }
    ])
    // Git still records the old path until `git worktree repair`; re-keying would orphan it.
    expect(plan.staleLinkedWorktreeIds).toEqual(['r::/old/app/.worktrees/stale'])
  })

  it('leaves a destination Orca already tracks alone', () => {
    const plan = planRepoRelinkWorktreeMoves({
      repoId: 'r',
      oldPath: '/old/app',
      newPath: '/new/app',
      knownWorktreeIds: ['r::/old/app/wt', 'r::/new/app/wt'],
      gitWorktrees: [worktree('/new/app', true), worktree('/new/app/wt')]
    })
    expect(plan.moves).toEqual([{ oldWorktreeId: 'r::/old/app', newWorktreeId: 'r::/new/app' }])
  })

  it('matches Windows paths case-insensitively and keeps git spelling for the new id', () => {
    const plan = planRepoRelinkWorktreeMoves({
      repoId: 'r',
      oldPath: 'C:\\Old\\App',
      newPath: 'D:/New/App',
      knownWorktreeIds: ['r::c:\\old\\app', 'r::C:\\Old\\App\\wt'],
      gitWorktrees: [worktree('D:/New/App', true), worktree('D:/New/App/wt')]
    })
    // The registered spelling wins; a second spelling must not overwrite it on the same id.
    expect(plan.moves).toEqual([
      { oldWorktreeId: 'r::C:\\Old\\App', newWorktreeId: 'r::D:/New/App' },
      { oldWorktreeId: 'r::C:\\Old\\App\\wt', newWorktreeId: 'r::D:/New/App/wt' }
    ])
  })
})
