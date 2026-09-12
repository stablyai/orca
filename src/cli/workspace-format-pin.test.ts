import { describe, expect, it } from 'vitest'
import { formatWorktreeList, formatWorktreePs } from './format'
import type { RuntimeWorktreePsSummary, RuntimeWorktreeRecord } from '../shared/runtime-types'

function record(overrides: Partial<RuntimeWorktreeRecord> = {}): RuntimeWorktreeRecord {
  return {
    id: 'repo::/tmp/repo/child',
    repoId: 'repo',
    path: '/tmp/repo/child',
    branch: 'feature/child',
    isMainWorktree: false,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    linkedIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    comment: '',
    git: { path: '/tmp/repo/child', head: 'abc123', branch: 'feature/child' },
    ...overrides
  } as RuntimeWorktreeRecord
}

function summary(overrides: Partial<RuntimeWorktreePsSummary> = {}): RuntimeWorktreePsSummary {
  return {
    worktreeId: 'repo::/tmp/repo/child',
    repoId: 'repo',
    repo: 'repo',
    path: '/tmp/repo/child',
    branch: 'feature/child',
    isArchived: false,
    isMainWorktree: false,
    hasHostSidebarActivity: false,
    parentWorktreeId: null,
    childWorktreeIds: [],
    displayName: 'child',
    workspaceStatus: 'todo',
    sortOrder: 0,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    comment: '',
    isPinned: false,
    isActive: false,
    unread: false,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    lastOutputAt: null,
    preview: '',
    status: 'inactive',
    agents: [],
    ...overrides
  }
}

describe('pinned state in worktree listings', () => {
  it('reports the pinned flag beside the unread flag in ps', () => {
    const output = formatWorktreePs({
      worktrees: [summary({ isPinned: true }), summary({ path: '/tmp/repo/other' })],
      totalCount: 2,
      truncated: false
    })

    expect(output).toContain('unread:no  pinned:yes')
    expect(output).toContain('unread:no  pinned:no')
  })

  it('reports the pinned flag per workspace in list', () => {
    const output = formatWorktreeList({
      worktrees: [
        record({ id: 'repo::/tmp/repo/pinned', path: '/tmp/repo/pinned', isPinned: true }),
        record()
      ],
      totalCount: 2,
      truncated: false
    })

    expect(output).toContain('pinned: yes')
    expect(output).toContain('pinned: no')
  })
})
