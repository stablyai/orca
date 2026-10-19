import { NO_WORKSPACE_ROW_FILTERS } from '../../../src/shared/workspace-view/workspace-row-filters'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Worktree } from './workspace-list-sections'
import { NO_PROJECT_SECTION_CATALOG, buildSections } from './workspace-list-sections'
import { DEFAULT_WORKSPACE_STATUSES } from '../../../src/shared/workspace-statuses'

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

describe('a pinned parent with an unpinned child', () => {
  const parent = worktree({ worktreeId: 'parent', displayName: 'parent', isPinned: true })
  const child = worktree({
    worktreeId: 'child',
    displayName: 'child',
    parentWorktreeId: 'parent'
  })

  function nesting(showPinnedInGroups: boolean) {
    const sections = buildSections(
      [child, parent],
      'name',
      { ...NO_WORKSPACE_ROW_FILTERS },
      '',
      'repo',
      new Set(),
      NO_PROJECT_SECTION_CATALOG,
      DEFAULT_WORKSPACE_STATUSES,
      new Set(),
      showPinnedInGroups
    )
    return sections.map((section) => ({
      key: section.key,
      rows: section.data.map((row) => [row.worktreeId, row.lineageDepth])
    }))
  }

  const nested = [
    ['parent', 0],
    ['child', 1]
  ]

  it('moves the child into Pinned under its parent by default', () => {
    expect(nesting(false)).toEqual([{ key: 'pinned', rows: nested }])
  })

  it('nests the child under its parent in both sections when the desktop setting is on', () => {
    expect(nesting(true)).toEqual([
      { key: 'pinned', rows: nested },
      { key: 'repo:repo-1', rows: nested }
    ])
  })
})

it('follows a pin through a child hidden by search, like desktop', () => {
  const root = worktree({ worktreeId: 'root', displayName: 'alpha-root', isPinned: true })
  const middle = worktree({
    worktreeId: 'middle',
    displayName: 'middle',
    parentWorktreeId: 'root'
  })
  const leaf = worktree({
    worktreeId: 'leaf',
    displayName: 'alpha-sub',
    parentWorktreeId: 'middle'
  })

  const sections = buildSections(
    [root, middle, leaf],
    'name',
    { ...NO_WORKSPACE_ROW_FILTERS },
    'alpha',
    'repo',
    new Set()
  )

  expect(
    sections.map((section) => ({
      key: section.key,
      rows: section.data.map((row) => row.worktreeId)
    }))
  ).toEqual([{ key: 'pinned', rows: ['root', 'leaf'] }])
})
