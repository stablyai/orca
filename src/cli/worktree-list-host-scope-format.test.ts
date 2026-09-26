import { describe, expect, it } from 'vitest'
import { formatWorktreeList, formatWorktreePs } from './format'
import type {
  RuntimeWorktreeListResult,
  RuntimeWorktreePsResult,
  RuntimeWorktreePsSummary,
  RuntimeWorktreeRecord
} from '../shared/runtime-types'

function worktreeRecord(overrides: Partial<RuntimeWorktreeRecord> = {}): RuntimeWorktreeRecord {
  return {
    id: 'repo::/repo',
    repoId: 'repo',
    path: '/repo',
    branch: 'main',
    displayName: 'main',
    isArchived: false,
    isMainWorktree: true,
    linkedIssue: null,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    git: { isClean: true, ahead: 0, behind: 0 },
    ...overrides
  }
}

function worktreePsSummary(
  overrides: Partial<RuntimeWorktreePsSummary> = {}
): RuntimeWorktreePsSummary {
  return {
    worktreeId: 'repo::/repo',
    repoId: 'repo',
    repo: 'repo',
    path: '/repo',
    branch: 'main',
    isArchived: false,
    isMainWorktree: true,
    hasHostSidebarActivity: false,
    parentWorktreeId: null,
    childWorktreeIds: [],
    displayName: 'main',
    workspaceStatus: 'active',
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

function listResult(overrides: Partial<RuntimeWorktreeListResult> = {}): RuntimeWorktreeListResult {
  return { worktrees: [worktreeRecord()], totalCount: 1, truncated: false, ...overrides }
}

function psResult(overrides: Partial<RuntimeWorktreePsResult> = {}): RuntimeWorktreePsResult {
  return { worktrees: [worktreePsSummary()], totalCount: 1, truncated: false, ...overrides }
}

describe('formatWorktreeList host identity', () => {
  it('prints the execution host each worktree runs on', () => {
    const output = formatWorktreeList(
      listResult({ worktrees: [worktreeRecord({ hostId: 'ssh:box-1' })] })
    )

    expect(output).toContain('host=ssh:box-1')
  })

  it('prints unverifiable, not local, for a row whose host the runtime could not name', () => {
    const output = formatWorktreeList(listResult())

    expect(output).toContain('host=unverifiable')
    expect(output).not.toContain('host=local')
  })
})

describe('formatWorktreeList scope declaration', () => {
  it('states the covered and omitted hosts', () => {
    const output = formatWorktreeList(
      listResult({
        hostScope: { hostIds: ['local'], omittedHostIds: ['ssh:box-1'] }
      })
    )

    expect(output).toContain('scope: local')
    expect(output).toContain('not covered: ssh:box-1')
  })

  it('keeps an empty listing self-describing instead of reading as absolute', () => {
    const output = formatWorktreeList(
      listResult({
        worktrees: [],
        totalCount: 0,
        hostScope: { hostIds: ['local'], omittedHostIds: ['ssh:box-1'] }
      })
    )

    expect(output).toContain('No worktrees found')
    expect(output).toContain('scope: local')
    expect(output).toContain('not covered: ssh:box-1')
  })

  it('says the scope is unverifiable when the host predates the field', () => {
    const output = formatWorktreeList(listResult())

    expect(output).toContain('scope: unverifiable')
    expect(output).not.toContain('scope: local')
  })
})

describe('formatWorktreePs host identity', () => {
  it('prints the execution host each worktree runs on', () => {
    const output = formatWorktreePs(
      psResult({ worktrees: [worktreePsSummary({ hostId: 'ssh:box-1' })] })
    )

    expect(output).toContain('host=ssh:box-1')
  })
})

describe('formatWorktreePs scope declaration', () => {
  it('states the covered and omitted hosts', () => {
    const output = formatWorktreePs(
      psResult({
        hostScope: { hostIds: ['local'], omittedHostIds: ['ssh:box-1'] }
      })
    )

    expect(output).toContain('scope: local')
    expect(output).toContain('not covered: ssh:box-1')
  })
})
