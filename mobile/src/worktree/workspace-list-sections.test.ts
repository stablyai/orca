import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Worktree } from './workspace-list-sections'
import { buildSections, filterWorktrees, getWorktreeStatus } from './workspace-list-sections'

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

    expect(sections).toEqual([
      { title: 'orca', data: [worktree({ repoId: 'repo-1', repo: 'orca' })] },
      { title: 'zoom-img', data: [] }
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

    expect(sections).toEqual([])
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

    expect(sections).toEqual([{ title: 'zoom-img', data: [] }])
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

    expect(sections).toEqual([{ title: 'empty-repo', data: [] }])
  })
})
