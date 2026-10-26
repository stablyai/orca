import { describe, expect, it } from 'vitest'
import { NO_PROJECT_SECTION_CATALOG, buildSections, type Worktree } from './workspace-list-sections'
import {
  applyDesktopViewSettings,
  type MobileViewState,
  type WorkspaceViewSettings,
  INITIAL_MOBILE_VIEW,
  rowFiltersForView
} from './workspace-view-settings'

// Repo display names can collide across hosts; an incomplete/name-keyed repo catalog must never drop workspace rows.

function worktree(repoId: string, id: string, repo = repoId): Worktree {
  return {
    workspaceKind: 'git',
    worktreeId: id,
    repoId,
    repo,
    branch: `feature/${id}`,
    displayName: id,
    path: `/tmp/orca/${repoId}/${id}`,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null,
    status: 'inactive',
    agents: []
  }
}

const base: MobileViewState = { ...INITIAL_MOBILE_VIEW, sharesOtherClientFilter: true }

// Build the host screen’s list from synced view settings and catalog [displayName, id] pairs.
function visibleWorktreeIds(
  worktrees: Worktree[],
  catalogRepos: readonly (readonly [string, string])[],
  desktop: WorkspaceViewSettings = {}
): string[] {
  const state = applyDesktopViewSettings(base, desktop)
  const sections = buildSections(
    worktrees,
    state.sortBy,
    rowFiltersForView(state),
    '',
    state.groupBy,
    new Set(),
    {
      ...NO_PROJECT_SECTION_CATALOG,
      repos: catalogRepos.map(([displayName, id]) => ({ id, displayName, path: `/repos/${id}` }))
    },
    state.workspaceStatuses,
    new Set(state.collapsedGroups)
  )
  return sections.flatMap((section) => section.data.map((w) => w.worktreeId)).sort()
}

describe('every worktree stays visible regardless of repo.list contents', () => {
  it('shows worktrees whose repoId is missing from repo.list', () => {
    const worktrees = [
      worktree('orca-local', 'a'),
      worktree('orca-local', 'b'),
      worktree('orca-runtime', 'c')
    ]
    const catalogRepos = [['orca-runtime', 'orca-runtime']] as const

    expect(visibleWorktreeIds(worktrees, catalogRepos)).toEqual(['a', 'b', 'c'])
  })

  it('shows every worktree when the same repo name maps to two host-specific ids', () => {
    // Same-name local/runtime repos expose any name-keyed map that discards an owner id.
    const worktrees = [
      worktree('orca-local', 'local-1', 'orca'),
      worktree('orca-local', 'local-2', 'orca'),
      worktree('orca-runtime', 'runtime-1', 'orca')
    ]
    const catalogRepos = [['orca', 'orca-runtime']] as const

    expect(visibleWorktreeIds(worktrees, catalogRepos)).toEqual(['local-1', 'local-2', 'runtime-1'])
  })

  it("narrows to the desktop's shown hosts, and its legacy scope alone narrows too", () => {
    const worktrees = [
      { ...worktree('local-repo', 'x'), hostId: 'local' as const },
      { ...worktree('runtime-repo', 'y'), hostId: 'runtime:devbox' as const }
    ]
    const catalogRepos = [
      ['local-repo', 'local-repo'],
      ['runtime-repo', 'runtime-repo']
    ] as const

    expect(
      visibleWorktreeIds(worktrees, catalogRepos, { visibleWorkspaceHostIds: ['runtime:devbox'] })
    ).toEqual(['y'])
    expect(
      visibleWorktreeIds(worktrees, catalogRepos, {
        visibleWorkspaceHostIds: null,
        workspaceHostScope: 'local'
      })
    ).toEqual(['x'])
    expect(visibleWorktreeIds(worktrees, catalogRepos, { workspaceHostScope: 'all' })).toEqual([
      'x',
      'y'
    ])
  })
})
