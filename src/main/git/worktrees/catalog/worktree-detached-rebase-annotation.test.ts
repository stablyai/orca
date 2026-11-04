import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'

const { readRebaseOperation } = vi.hoisted(() => ({ readRebaseOperation: vi.fn() }))
vi.mock('../../source-control/git-conflict-operation', () => ({ readRebaseOperation }))

import { annotateDetachedRebaseOperations } from './worktree-detached-rebase-annotation'

const DETACHED: GitWorktreeInfo = {
  path: '/repos/hung-mount/review',
  head: '0123456789abcdef0123456789abcdef01234567',
  branch: '',
  isBare: false,
  isMainWorktree: false
}

afterEach(() => {
  vi.useRealTimers()
  readRebaseOperation.mockReset()
})

describe('annotateDetachedRebaseOperations', () => {
  it('returns the raw row within its 2s budget when Git metadata never answers', async () => {
    vi.useFakeTimers()
    // This path's read never settles, so it stays marked stuck for the module's lifetime.
    readRebaseOperation.mockReturnValue(new Promise(() => {}))

    const first = annotateDetachedRebaseOperations([DETACHED])
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(first).resolves.toEqual([DETACHED])

    // A checkout whose read is still stuck answers unknown at once instead of waiting again.
    await expect(annotateDetachedRebaseOperations([DETACHED])).resolves.toEqual([DETACHED])
  })
})
