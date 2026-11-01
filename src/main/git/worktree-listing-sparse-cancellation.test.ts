import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import type { GitWorktreeExecOptions } from './worktree-operation-options'

const { sparseProbe } = vi.hoisted(() => ({
  sparseProbe:
    vi.fn<
      (repoPath: string, worktreePath: string, options?: GitWorktreeExecOptions) => Promise<boolean>
    >()
}))

vi.mock('./worktree-sparse-checkout-cache', () => ({
  detectSparseCheckoutCached: sparseProbe
}))
vi.mock('./worktree-list-reader', () => ({
  readCheckedOutBranchRef: vi.fn(),
  readRepoCommonDirFromGit: vi.fn(),
  readRepoLocation: vi.fn(),
  readTranslatedWorktreeGraph: vi.fn(),
  readWorktreeHeadOid: vi.fn(),
  readWorktreeList: vi.fn()
}))

import { annotateSparseCheckoutStatus } from './worktree-listing'

function listedWorktree(index: number): GitWorktreeInfo {
  return {
    path: `/repo/task-${index}`,
    head: 'a'.repeat(40),
    branch: `refs/heads/task-${index}`,
    isBare: false,
    isMainWorktree: false
  }
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

beforeEach(() => {
  sparseProbe.mockReset()
})

describe('sparse worktree listing cancellation', () => {
  it('rejects while eight probes are pending and claims no more rows after they settle', async () => {
    const rows = Array.from({ length: 32 }, (_, index) => listedWorktree(index))
    const controller = new AbortController()
    const reason = new Error('Listing closed')
    const releases: (() => void)[] = []
    sparseProbe.mockImplementation(
      () => new Promise((resolve) => releases.push(() => resolve(true)))
    )
    const outcome = vi.fn<(result: unknown) => void>()
    const observed = annotateSparseCheckoutStatus('/repo', rows, {
      signal: controller.signal,
      wslDistro: 'Ubuntu'
    }).then(
      (result) => outcome(result),
      (error: unknown) => outcome(error)
    )

    try {
      await nextTurn()
      expect(sparseProbe).toHaveBeenCalledTimes(8)
      expect(sparseProbe).toHaveBeenCalledWith('/repo', rows[0]?.path, {
        signal: controller.signal,
        wslDistro: 'Ubuntu'
      })
      controller.abort(reason)
      await nextTurn()
      expect(outcome).toHaveBeenCalledExactlyOnceWith(reason)
      expect(sparseProbe).toHaveBeenCalledTimes(8)
    } finally {
      releases.splice(0).forEach((release) => release())
    }
    await observed
    await nextTurn()
    expect(sparseProbe).toHaveBeenCalledTimes(8)
    expect(outcome).toHaveBeenCalledExactlyOnceWith(reason)
    expect(rows.every((row) => row.isSparse === undefined)).toBe(true)
  })

  it('observes worker rejections when the first probe synchronously aborts the request', async () => {
    const controller = new AbortController()
    const reason = new Error('First probe closed the request')
    const releases: (() => void)[] = []
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error)
    }
    process.on('unhandledRejection', onUnhandled)
    sparseProbe.mockImplementation(() => {
      controller.abort(reason)
      return new Promise((resolve) => releases.push(() => resolve(true)))
    })
    try {
      await expect(
        annotateSparseCheckoutStatus(
          '/repo',
          Array.from({ length: 32 }, (_, index) => listedWorktree(index)),
          { signal: controller.signal }
        )
      ).rejects.toBe(reason)
      expect(sparseProbe).toHaveBeenCalledTimes(1)
      releases.splice(0).forEach((release) => release())
      await nextTurn()
      expect(sparseProbe).toHaveBeenCalledTimes(1)
      expect(unhandled).toEqual([])
    } finally {
      releases.splice(0).forEach((release) => release())
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
