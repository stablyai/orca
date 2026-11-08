import { describe, expect, it } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { writeWorktreeSortOrder } from './worktree-sort-order-write'

describe('writeWorktreeSortOrder', () => {
  it('re-ranks every writable row when a blocked row sits in the requested order', () => {
    const ranks: Record<string, number> = {
      'repo::/a': 7_000,
      'repo::/b': 8_000,
      'repo::/c': 5_000
    }
    const repo: Repo = {
      id: 'repo',
      path: '/repo',
      displayName: 'repo',
      badgeColor: '',
      addedAt: 0
    }
    const meta = (sortOrder: number): WorktreeMeta => ({
      displayName: '',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder,
      lastActivityAt: 0
    })
    const store = {
      getWorktreeMeta: (id: string) => (ranks[id] === undefined ? undefined : meta(ranks[id])),
      getRepos: () => [repo],
      setWorktreeMeta: (target: { id: string }, updates: Partial<WorktreeMeta>) => {
        if (updates.sortOrder !== undefined) {
          ranks[target.id] = updates.sortOrder
        }
      }
    }

    writeWorktreeSortOrder(
      store,
      { orderedIds: ['repo::/a', 'repo::/b', 'repo::/c'] },
      (id) => id === 'repo::/b',
      9_000
    )

    expect(ranks).toEqual({ 'repo::/a': 9_000, 'repo::/b': 8_000, 'repo::/c': 7_000 })
  })
})
