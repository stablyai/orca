import { NO_WORKSPACE_ROW_FILTERS } from '../../../src/shared/workspace-view/workspace-row-filters'
import { describe, expect, it } from 'vitest'
import { buildFilterRepos } from './workspace-filter-repos'
import { filterWorktrees, type Worktree } from './workspace-list-sections'

function row(worktreeId: string, repoId: string, hostId: Worktree['hostId']): Worktree {
  return {
    worktreeId,
    repoId,
    hostId,
    repo: 'orca',
    branch: 'feature',
    displayName: worktreeId,
    path: `/tmp/${worktreeId}`,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null
  }
}

describe('the repo filter', () => {
  it("lists each host's same-named repo separately, by id, as the desktop's filter does", () => {
    const repos = buildFilterRepos(
      [
        { id: 'local-orca', displayName: 'orca', path: '/Users/me/orca', badgeColor: '#111111' },
        {
          id: 'm4-orca',
          displayName: 'orca',
          path: '/Users/m4air/orca/orca',
          executionHostId: 'runtime:m4air'
        },
        { id: 'assets', displayName: 'design-assets', path: '/Users/me/design-assets' }
      ],
      []
    )

    expect(repos.map(({ key, id, name }) => ({ key, id, name }))).toEqual([
      { key: 'local|local-orca', id: 'local-orca', name: 'orca' },
      { key: 'runtime:m4air|m4-orca', id: 'm4-orca', name: 'orca' },
      { key: 'local|assets', id: 'assets', name: 'design-assets' }
    ])
    expect(repos[0]?.color).toBe('#111111')
  })

  it('lists the repos the rows name until a catalog answers, still one per repo id', () => {
    const repos = buildFilterRepos(
      [],
      [row('a', 'local-orca', 'local'), row('b', 'm4-orca', 'runtime:m4air')]
    )

    expect(repos.map((repo) => repo.id)).toEqual(['local-orca', 'm4-orca'])
  })

  it('filters by the picked repo id, leaving the same-named repo on another host out', () => {
    const rows = [row('a', 'local-orca', 'local'), row('b', 'm4-orca', 'runtime:m4air')]

    expect(
      filterWorktrees(rows, { ...NO_WORKSPACE_ROW_FILTERS, filterRepoIds: ['m4-orca'] }, '').map(
        (w) => w.worktreeId
      )
    ).toEqual(['b'])
  })
})
