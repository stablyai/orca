import { beforeEach, describe, expect, it, vi } from 'vitest'
import { STARTUP_WORKTREE_HYDRATION_LIMIT } from '../../shared/startup-worktree-hydration-budget'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import {
  resetStartupWorktreeHydrationCensusForTests,
  readStartupWorktreeHydrationCensus
} from './startup-worktree-hydration-census'

const detectSparseCheckoutCached = vi.hoisted(() => vi.fn(async () => false))

vi.mock('./worktree-sparse-checkout-cache', () => ({
  detectSparseCheckoutCached
}))

import { annotateSparseCheckoutStatus } from './worktree-listing'

function worktree(path: string, isMainWorktree: boolean): GitWorktreeInfo {
  return {
    path,
    head: 'abc',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree
  }
}

describe('annotateSparseCheckoutStatus hydration cap', () => {
  beforeEach(() => {
    detectSparseCheckoutCached.mockClear()
    resetStartupWorktreeHydrationCensusForTests()
  })

  it('probes every checkout when the catalog is under the startup limit', async () => {
    const worktrees = [worktree('/repo', true), worktree('/repo-feature', false)]
    await annotateSparseCheckoutStatus('/repo', worktrees)

    expect(detectSparseCheckoutCached).toHaveBeenCalledTimes(2)
    expect(readStartupWorktreeHydrationCensus()).toBeNull()
  })

  it('does not probe every historical checkout, and records worktree count and limit', async () => {
    const worktrees = [
      worktree('/repo', true),
      ...Array.from({ length: STARTUP_WORKTREE_HYDRATION_LIMIT + 40 }, (_, index) =>
        worktree(`/wt/${index}`, false)
      )
    ]
    await annotateSparseCheckoutStatus('/repo', worktrees)

    expect(detectSparseCheckoutCached).toHaveBeenCalledTimes(STARTUP_WORKTREE_HYDRATION_LIMIT)
    expect(detectSparseCheckoutCached).toHaveBeenCalledWith('/repo', '/repo', {})
    expect(readStartupWorktreeHydrationCensus()).toEqual({
      worktreeCount: worktrees.length,
      limit: STARTUP_WORKTREE_HYDRATION_LIMIT,
      message: `worktree count = ${worktrees.length}, limit = ${STARTUP_WORKTREE_HYDRATION_LIMIT}`
    })
  })
})
