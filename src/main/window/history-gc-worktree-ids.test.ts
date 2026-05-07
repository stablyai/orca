import { describe, expect, it, vi } from 'vitest'
import { getKnownWorktreeIdsForHistoryGc } from './history-gc-worktree-ids'

describe('getKnownWorktreeIdsForHistoryGc', () => {
  it('uses persisted metadata keys without probing repo paths', () => {
    const store = {
      getAllWorktreeMeta: vi.fn(() => ({
        'repo-1::/worktree-a': {},
        'repo-2::/worktree-b': {}
      }))
    }

    expect(getKnownWorktreeIdsForHistoryGc(store as never)).toEqual(
      new Set(['repo-1::/worktree-a', 'repo-2::/worktree-b'])
    )
    expect(store.getAllWorktreeMeta).toHaveBeenCalledTimes(1)
  })
})
