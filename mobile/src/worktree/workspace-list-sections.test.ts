import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Worktree } from './workspace-list-sections'
import { buildSections, filterWorktrees, getWorktreeStatus } from './workspace-list-sections'
import { DEFAULT_MOBILE_WORKSPACE_STATUSES } from './mobile-workspace-statuses'

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
    preview: '',
    unread: false,
    isPinned: false,
    linkedPR: null,
    status: 'inactive',
    agents: [],
    ...overrides
  }
}

function withoutSectionListKeys(sections: ReturnType<typeof buildSections>) {
  return sections.map((section) => ({
    ...section,
    data: section.data.map(
      ({
        sectionListKey: _sectionListKey,
        lineageDepth: _lineageDepth,
        lineageChildCount: _lineageChildCount,
        lineageCollapsed: _lineageCollapsed,
        isLastLineageChild: _isLastLineageChild,
        ...item
      }) => item
    )
  }))
}

describe('filterWorktrees', () => {
  it('hides archived worktrees', () => {
    const visible = worktree({ worktreeId: 'visible' })
    const archived = worktree({ worktreeId: 'archived', isArchived: true })

    expect(
      filterWorktrees(
        [visible, archived],
        { filterRepoIds: new Set(), hideSleeping: false, hideDefaultBranch: false },
        ''
      )
    ).toEqual([visible])
  })

  it('uses host sidebar activity for sleeping filtering when available', () => {
    const visible = worktree({
      worktreeId: 'visible',
      status: 'inactive',
      liveTerminalCount: 0,
      hasHostSidebarActivity: true
    })
    const retainedPtyOnly = worktree({
      worktreeId: 'retained-pty-only',
      status: 'active',
      liveTerminalCount: 3,
      hasHostSidebarActivity: false
    })

    expect(
      filterWorktrees(
        [visible, retainedPtyOnly],
        { filterRepoIds: new Set(), hideSleeping: true, hideDefaultBranch: false },
        ''
      )
    ).toEqual([visible])
  })

  it('uses the host-provided main-worktree flag for default branch hiding', () => {
    const main = worktree({
      worktreeId: 'main',
      branch: 'main',
      isMainWorktree: true
    })
    const featureNamedMain = worktree({
      worktreeId: 'feature-main',
      branch: 'main',
      isMainWorktree: false
    })

    expect(
      filterWorktrees(
        [main, featureNamedMain],
        { filterRepoIds: new Set(), hideSleeping: false, hideDefaultBranch: true },
        ''
      )
    ).toEqual([featureNamedMain])
  })

  it('keeps folder workspaces when default branch hiding is enabled', () => {
    const folder = worktree({
      workspaceKind: 'folder-workspace',
      worktreeId: 'folder:workspace-1',
      branch: '',
      isMainWorktree: true
    })

    expect(
      filterWorktrees(
        [folder],
        { filterRepoIds: new Set(), hideSleeping: false, hideDefaultBranch: true },
        ''
      )
    ).toEqual([folder])
  })
})

describe('getWorktreeStatus', () => {
  it('uses host sidebar inactivity for the row status dot when available', () => {
    expect(
      getWorktreeStatus(
        worktree({
          status: 'active',
          liveTerminalCount: 3,
          hasHostSidebarActivity: false
        })
      )
    ).toBe('inactive')
  })

  it('marks host sidebar activity active when runtime status has not caught up', () => {
    expect(
      getWorktreeStatus(
        worktree({
          status: 'inactive',
          liveTerminalCount: 0,
          hasHostSidebarActivity: true
        })
      )
    ).toBe('active')
  })
})

describe('buildSections', () => {
  it('uses desktop manual order ranks in Manual sort mode', () => {
    const low = worktree({ worktreeId: 'low', displayName: 'low', manualOrder: 10 })
    const high = worktree({ worktreeId: 'high', displayName: 'high', manualOrder: 30 })
    const fallback = worktree({ worktreeId: 'fallback', displayName: 'fallback', sortOrder: 20 })

    const sections = buildSections(
      [low, high, fallback],
      'manual',
      { filterRepoIds: new Set(), hideSleeping: false, hideDefaultBranch: false },
      '',
      'workspaceStatus',
      new Set(),
      new Map(),
      DEFAULT_MOBILE_WORKSPACE_STATUSES
    )

    expect(sections[0]?.data.map((worktree) => worktree.worktreeId)).toEqual([
      'high',
      'fallback',
      'low'
    ])
  })

  it('renders empty repo sections from repo placeholders in repo grouping', () => {
    const sections = buildSections(
      [worktree({ repoId: 'repo-1', repo: 'orca' })],
      'manual',
      { filterRepoIds: new Set(), hideSleeping: false, hideDefaultBranch: false },
      '',
      'repo',
      new Set(),
      new Map([
        ['orca', 'repo-1'],
        ['zoom-img', 'repo-missing']
      ])
    )

    expect(withoutSectionListKeys(sections)).toEqual([
      {
        key: 'repo:repo-1',
        title: 'orca',
        data: [worktree({ repoId: 'repo-1', repo: 'orca' })]
      },
      { key: 'repo:repo-missing', title: 'zoom-img', data: [] }
    ])
  })

  it('does not render empty repo sections outside repo grouping', () => {
    const sections = buildSections(
      [],
      'manual',
      { filterRepoIds: new Set(), hideSleeping: false, hideDefaultBranch: false },
      '',
      'none',
      new Set(),
      new Map([['zoom-img', 'repo-missing']])
    )

    expect(withoutSectionListKeys(sections)).toEqual([])
  })

  it('applies repo filters and search to empty repo sections', () => {
    const sections = buildSections(
      [],
      'manual',
      {
        filterRepoIds: new Set(['repo-matching', 'repo-hidden']),
        hideSleeping: false,
        hideDefaultBranch: false
      },
      'zoom',
      'repo',
      new Set(),
      new Map([
        ['zoom-img', 'repo-matching'],
        ['repo', 'repo-hidden'],
        ['zoom-hidden', 'repo-unfiltered']
      ])
    )

    expect(withoutSectionListKeys(sections)).toEqual([
      { key: 'repo:repo-matching', title: 'zoom-img', data: [] }
    ])
  })

  it('does not add an empty repo section when all of its worktrees are filtered out', () => {
    const sleeping = worktree({
      repoId: 'repo-sleeping',
      repo: 'sleeping-repo',
      hasHostSidebarActivity: false
    })
    const sections = buildSections(
      [sleeping],
      'manual',
      { filterRepoIds: new Set(), hideSleeping: true, hideDefaultBranch: false },
      '',
      'repo',
      new Set(),
      new Map([
        ['sleeping-repo', 'repo-sleeping'],
        ['empty-repo', 'repo-empty']
      ])
    )

    expect(withoutSectionListKeys(sections)).toEqual([
      { key: 'repo:repo-empty', title: 'empty-repo', data: [] }
    ])
  })

  it('groups by desktop workspace status labels and order', () => {
    const review = worktree({
      worktreeId: 'review',
      workspaceStatus: 'in-review',
      status: 'active'
    })
    const progress = worktree({
      worktreeId: 'progress',
      workspaceStatus: 'in-progress',
      status: 'working'
    })

    const sections = buildSections(
      [progress, review],
      'manual',
      { filterRepoIds: new Set(), hideSleeping: false, hideDefaultBranch: false },
      '',
      'workspaceStatus',
      new Set(),
      new Map(),
      DEFAULT_MOBILE_WORKSPACE_STATUSES
    )

    expect(sections.map((section) => ({ key: section.key, title: section.title }))).toEqual([
      { key: 'workspace-status:in-review', title: 'In review' },
      { key: 'workspace-status:in-progress', title: 'In progress' }
    ])
  })

  it('falls back to the default status catalog when desktop sends none', () => {
    const progress = worktree({
      worktreeId: 'progress',
      workspaceStatus: 'in-progress',
      status: 'working'
    })

    const sections = buildSections(
      [progress],
      'manual',
      { filterRepoIds: new Set(), hideSleeping: false, hideDefaultBranch: false },
      '',
      'workspaceStatus',
      new Set(),
      new Map(),
      []
    )

    expect(sections.map((section) => ({ key: section.key, title: section.title }))).toEqual([
      { key: 'workspace-status:in-progress', title: 'In progress' }
    ])
    expect(sections[0]?.data.map((worktree) => worktree.worktreeId)).toEqual(['progress'])
  })

  it('does not duplicate pinned worktrees in their canonical status group', () => {
    const pinned = worktree({
      worktreeId: 'pinned',
      workspaceStatus: 'in-progress',
      isPinned: true
    })

    const sections = buildSections(
      [pinned],
      'manual',
      { filterRepoIds: new Set(), hideSleeping: false, hideDefaultBranch: false },
      '',
      'workspaceStatus',
      new Set(),
      new Map(),
      DEFAULT_MOBILE_WORKSPACE_STATUSES
    )

    expect(withoutSectionListKeys(sections)).toEqual([
      { key: 'pinned', title: 'Pinned', icon: 'pin', data: [pinned] }
    ])
  })

  it('nests child workspaces under visible parents in grouped sections', () => {
    const parent = worktree({
      worktreeId: 'parent',
      displayName: 'parent',
      workspaceStatus: 'in-progress'
    })
    const child = worktree({
      worktreeId: 'child',
      displayName: 'child',
      parentWorktreeId: 'parent',
      workspaceStatus: 'in-progress'
    })

    const sections = buildSections(
      [child, parent],
      'manual',
      { filterRepoIds: new Set(), hideSleeping: false, hideDefaultBranch: false },
      '',
      'workspaceStatus',
      new Set(),
      new Map(),
      DEFAULT_MOBILE_WORKSPACE_STATUSES
    )

    expect(sections[0]?.data.map((worktree) => worktree.worktreeId)).toEqual(['parent', 'child'])
    expect(sections[0]?.data.map((worktree) => worktree.lineageDepth)).toEqual([0, 1])
  })

  it('collapses child workspaces under lineage parent rows', () => {
    const parent = worktree({
      worktreeId: 'parent',
      displayName: 'parent',
      workspaceStatus: 'in-progress'
    })
    const child = worktree({
      worktreeId: 'child',
      displayName: 'child',
      parentWorktreeId: 'parent',
      workspaceStatus: 'in-progress'
    })

    const sections = buildSections(
      [child, parent],
      'manual',
      { filterRepoIds: new Set(), hideSleeping: false, hideDefaultBranch: false },
      '',
      'workspaceStatus',
      new Set(),
      new Map(),
      DEFAULT_MOBILE_WORKSPACE_STATUSES,
      new Set(['workspace-lineage:parent'])
    )

    expect(sections[0]?.data.map((worktree) => worktree.worktreeId)).toEqual(['parent'])
    expect(sections[0]?.data[0]?.lineageChildCount).toBe(1)
    expect(sections[0]?.data[0]?.lineageCollapsed).toBe(true)
  })
})
