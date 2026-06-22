import { describe, expect, it } from 'vitest'
import type { Worktree } from './workspace-list-sections'
import {
  getHostScopedWorktrees,
  getVisibleRepoIdsByName,
  type RepoSectionSummary
} from './use-workspace-sections'

const repos: RepoSectionSummary[] = [
  { id: 'local-repo', displayName: 'local' },
  { id: 'ssh-repo', displayName: 'ssh', connectionId: 'builder' },
  { id: 'runtime-repo', displayName: 'runtime', executionHostId: 'runtime:devbox' }
]

describe('getVisibleRepoIdsByName', () => {
  it('keeps every repo when desktop is showing all hosts', () => {
    expect([...getVisibleRepoIdsByName({ repos }).entries()]).toEqual([
      ['local', 'local-repo'],
      ['ssh', 'ssh-repo'],
      ['runtime', 'runtime-repo']
    ])
  })

  it('filters repos to the desktop visible workspace hosts', () => {
    expect([
      ...getVisibleRepoIdsByName({
        repos,
        workspaceHostScope: 'all',
        visibleWorkspaceHostIds: ['runtime:devbox']
      }).entries()
    ]).toEqual([['runtime', 'runtime-repo']])
  })
})

describe('getHostScopedWorktrees', () => {
  const worktrees = [
    { worktreeId: 'local-worktree', repoId: 'local-repo' },
    { worktreeId: 'runtime-worktree', repoId: 'runtime-repo' }
  ] as Worktree[]

  it('keeps rows while repo metadata is still loading', () => {
    expect(
      getHostScopedWorktrees({
        displayWorktrees: worktrees,
        repoSummaries: [],
        visibleRepoIdsByName: new Map([['runtime', 'runtime-repo']])
      })
    ).toEqual(worktrees)
  })

  it('filters rows to the same visible repos used for empty placeholders', () => {
    expect(
      getHostScopedWorktrees({
        displayWorktrees: worktrees,
        repoSummaries: repos,
        visibleRepoIdsByName: new Map([['runtime', 'runtime-repo']])
      })
    ).toEqual([{ worktreeId: 'runtime-worktree', repoId: 'runtime-repo' }])
  })
})
