import { describe, expect, it } from 'vitest'
import type { PinnedWorktreeDisplayPolicy } from '../../../src/shared/worktree/pinned-display-policy'
import type { MobileGroupMode } from './workspace-view-settings'
import { buildSections, type Section, type Worktree } from './workspace-list-sections'
import { DEFAULT_MOBILE_WORKSPACE_STATUSES } from './mobile-workspace-statuses'
import { getMobileWorkspaceLineageGroupKey } from './mobile-workspace-lineage'

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    workspaceKind: 'git',
    worktreeId: 'worktree',
    repoId: 'repo-1',
    repo: 'orca',
    branch: 'feature/pinned',
    displayName: 'worktree',
    path: '/tmp/worktree',
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

function sectionsFor(
  worktrees: Worktree[],
  groupMode: MobileGroupMode,
  policy?: PinnedWorktreeDisplayPolicy
): Section[] {
  return buildSections(
    worktrees,
    'manual',
    { filterRepoIds: new Set(), hideSleeping: false, hideDefaultBranch: false },
    '',
    groupMode,
    new Set(),
    new Map(),
    DEFAULT_MOBILE_WORKSPACE_STATUSES,
    new Set(),
    policy
  )
}

function sectionKeysContaining(sections: Section[], worktreeId: string): string[] {
  return sections.flatMap((section) =>
    section.data.filter((row) => row.worktreeId === worktreeId).map(() => section.key)
  )
}

const GROUP_MODES: MobileGroupMode[] = ['none', 'repo', 'workspaceStatus', 'prStatus']

describe('buildSections pinned display policy', () => {
  const pinned = worktree({ worktreeId: 'pinned', displayName: 'pinned', isPinned: true })

  it.each(GROUP_MODES)('renders a pinned workspace once by default in %s grouping', (groupMode) => {
    expect(sectionKeysContaining(sectionsFor([pinned], groupMode), 'pinned')).toEqual(['pinned'])
  })

  it.each(GROUP_MODES)('renders a pinned workspace once for single-location in %s', (groupMode) => {
    const sections = sectionsFor([pinned], groupMode, 'single-location')
    expect(sectionKeysContaining(sections, 'pinned')).toEqual(['pinned'])
  })

  it.each(GROUP_MODES)('duplicates into the natural group when opted in for %s', (groupMode) => {
    const keys = sectionKeysContaining(
      sectionsFor([pinned], groupMode, 'duplicate-in-groups'),
      'pinned'
    )
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe('pinned')
    expect(keys[1]).not.toBe('pinned')
  })

  it('keeps a pinned folder workspace out of its repo group', () => {
    const folder = worktree({
      worktreeId: 'folder',
      workspaceKind: 'folder-workspace',
      isPinned: true
    })
    expect(sectionKeysContaining(sectionsFor([folder], 'repo'), 'folder')).toEqual(['pinned'])
  })

  it('leaves a same-id workspace on another host in its natural group', () => {
    const pinnedOnHostA = worktree({ worktreeId: 'shared', hostId: 'host-a', isPinned: true })
    const unpinnedOnHostB = worktree({ worktreeId: 'shared', hostId: 'host-b' })

    const sections = sectionsFor([pinnedOnHostA, unpinnedOnHostB], 'none')

    expect(sections.find((section) => section.key === 'pinned')?.data).toHaveLength(1)
    expect(
      sections.find((section) => section.key === 'all')?.data.map((row) => row.hostId)
    ).toEqual(['host-b'])
  })

  const lineageParent = worktree({
    worktreeId: 'parent',
    displayName: 'parent',
    isPinned: true,
    worktreeInstanceId: 'parent-instance'
  })
  const lineageChild = worktree({
    worktreeId: 'child',
    displayName: 'child',
    parentWorktreeId: 'parent',
    worktreeInstanceId: 'child-instance',
    lineageWorktreeInstanceId: 'child-instance',
    parentWorktreeInstanceId: 'parent-instance'
  })

  // Desktop pulls the pinned lineage subtree into Pinned (getPinnedSectionWorktrees). Without
  // that, single-location strips the parent out of its group and orphans the child there.
  it('follows a pinned parent into Pinned and keeps the child nested under it', () => {
    const sections = sectionsFor([lineageParent, lineageChild], 'none')

    expect(sectionKeysContaining(sections, 'child')).toEqual(['pinned'])
    expect(sectionKeysContaining(sections, 'parent')).toEqual(['pinned'])
    const pinnedRows = sections.find((section) => section.key === 'pinned')?.data ?? []
    expect(pinnedRows.map((row) => [row.worktreeId, row.lineageDepth])).toEqual([
      ['parent', 0],
      ['child', 1]
    ])
    expect(pinnedRows[0]?.lineageChildCount).toBe(1)
    expect(sections.some((section) => section.key === 'all')).toBe(false)
  })

  it('collapses the pinned subtree when its lineage group is collapsed', () => {
    const sections = buildSections(
      [lineageParent, lineageChild],
      'manual',
      { filterRepoIds: new Set(), hideSleeping: false, hideDefaultBranch: false },
      '',
      'none',
      new Set(),
      new Map(),
      DEFAULT_MOBILE_WORKSPACE_STATUSES,
      new Set([getMobileWorkspaceLineageGroupKey(lineageParent)])
    )

    expect(sectionKeysContaining(sections, 'child')).toEqual([])
    const pinnedRows = sections.find((section) => section.key === 'pinned')?.data ?? []
    expect(pinnedRows.map((row) => row.worktreeId)).toEqual(['parent'])
    expect(pinnedRows[0]?.lineageCollapsed).toBe(true)
  })

  it('leaves a stale-instance child in its natural group', () => {
    const staleChild = worktree({
      ...lineageChild,
      parentWorktreeInstanceId: 'recycled-parent-instance'
    })

    const sections = sectionsFor([lineageParent, staleChild], 'none')

    expect(sectionKeysContaining(sections, 'child')).toEqual(['all'])
    expect(sectionKeysContaining(sections, 'parent')).toEqual(['pinned'])
  })
})
