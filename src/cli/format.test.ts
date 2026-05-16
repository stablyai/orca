import { describe, expect, it } from 'vitest'
import { RuntimeRpcFailureError } from './runtime-client'
import { formatCliError, formatWorktreeList } from './format'
import type { RuntimeWorktreeRecord } from '../shared/runtime-types'

function worktree(overrides: Partial<RuntimeWorktreeRecord> = {}): RuntimeWorktreeRecord {
  const base: RuntimeWorktreeRecord = {
    id: 'repo::/tmp/repo/child',
    repoId: 'repo',
    path: '/tmp/repo/child',
    head: 'abc123',
    branch: 'feature/child',
    isBare: false,
    isMainWorktree: false,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    git: {
      path: '/tmp/repo/child',
      head: 'abc123',
      branch: 'feature/child',
      isBare: false,
      isMainWorktree: false
    },
    displayName: '',
    comment: ''
  }
  return { ...base, ...overrides }
}

describe('formatCliError', () => {
  it('prints runtime next steps for structured lineage errors', () => {
    const error = new RuntimeRpcFailureError({
      id: 'req_1',
      ok: false,
      error: {
        code: 'LINEAGE_PARENT_NOT_FOUND',
        message: 'Parent workspace was not found.',
        data: {
          nextSteps: [
            'Run `orca worktree list` and pass a valid --parent-worktree selector.',
            'Retry with --no-parent to create without lineage.',
            123
          ]
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })

    expect(formatCliError(error)).toBe(
      [
        'Parent workspace was not found.',
        'Next step: Run `orca worktree list` and pass a valid --parent-worktree selector.',
        'Next step: Retry with --no-parent to create without lineage.'
      ].join('\n')
    )
  })
})

describe('formatWorktreeList', () => {
  it('includes parent and child workspace relationships in text output', () => {
    const output = formatWorktreeList({
      worktrees: [
        worktree({
          id: 'repo::/tmp/repo/parent',
          path: '/tmp/repo/parent',
          branch: 'feature/parent',
          childWorktreeIds: ['repo::/tmp/repo/child']
        }),
        worktree({
          parentWorktreeId: 'repo::/tmp/repo/parent'
        })
      ],
      totalCount: 2,
      truncated: false
    })

    expect(output).toContain('parentWorktreeId: null')
    expect(output).toContain('childWorktreeIds: repo::/tmp/repo/child')
    expect(output).toContain('parentWorktreeId: repo::/tmp/repo/parent')
    expect(output).toContain('childWorktreeIds: []')
  })
})
