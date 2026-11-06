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
  it('eventually annotates later worktrees when each scan exhausts its budget', async () => {
    vi.useFakeTimers()
    const worktrees = Array.from({ length: 9 }, (_, index) => ({
      ...DETACHED,
      path: `/budget-repo/wt-${index}`
    }))
    const pending: ((value: { state: 'active'; branch: string }) => void)[] = []
    readRebaseOperation.mockImplementation(() => new Promise((resolve) => pending.push(resolve)))
    const settleReads = (): void => {
      for (const resolve of pending.splice(0)) {
        resolve({ state: 'active', branch: 'refs/heads/feature' })
      }
    }

    const first = annotateDetachedRebaseOperations('/budget-repo', worktrees)
    await vi.advanceTimersByTimeAsync(2_000)
    expect((await first)[8]).toEqual(worktrees[8])
    settleReads()
    await vi.advanceTimersByTimeAsync(0)
    const second = annotateDetachedRebaseOperations('/budget-repo', worktrees)
    settleReads()
    await vi.advanceTimersByTimeAsync(2_000)
    expect((await second)[8]).toEqual({
      ...worktrees[8],
      detachedRebase: { active: true, branch: 'refs/heads/feature' }
    })
    settleReads()
  })

  it('leaves overlapping observations unverified until the pending host read settles', async () => {
    let finish!: (verdict: { state: 'active'; branch: string }) => void
    readRebaseOperation.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    readRebaseOperation.mockResolvedValue({ state: 'none', headDetached: true })

    const first = annotateDetachedRebaseOperations('/repo', [DETACHED])
    try {
      await expect(annotateDetachedRebaseOperations('/repo', [DETACHED])).resolves.toEqual([
        DETACHED
      ])
    } finally {
      finish({ state: 'active', branch: 'refs/heads/feature' })
      await first
    }
    await expect(first).resolves.toEqual([
      { ...DETACHED, detachedRebase: { active: true, branch: 'refs/heads/feature' } }
    ])
    await expect(annotateDetachedRebaseOperations('/repo', [DETACHED])).resolves.toEqual([
      { ...DETACHED, detachedRebase: { active: false } }
    ])
  })
})
