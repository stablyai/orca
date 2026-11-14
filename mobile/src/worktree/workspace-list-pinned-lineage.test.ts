import { NO_WORKSPACE_ROW_FILTERS } from '../../../src/shared/workspace-view/workspace-row-filters'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { Worktree } from './workspace-list-sections'
import { buildSections } from './workspace-list-sections'

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
      rows: section.data.map((item) => item.row.worktreeId)
    }))
  ).toEqual([{ key: 'pinned', rows: ['root', 'leaf'] }])
})
