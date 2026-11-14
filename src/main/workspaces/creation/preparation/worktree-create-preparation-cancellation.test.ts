import {
  mocks,
  repo,
  store,
  flushBackgroundWork
} from '../../../__mocks__/worktree-create-preparation'
import { describe, expect, it, vi } from 'vitest'
import { WORKTREE_CREATE_PREPARATION_TTL_MS } from './worktree-create-preparation-pool'

import {
  consumePreparedWorktreeCreate,
  prepareWorktreeCreateForRepo
} from './worktree-create-preparation'

describe('worktree create preparation cancellation', () => {
  it('cancels an evicted checkout and cleans up with the original options', async () => {
    let signal: AbortSignal | undefined
    mocks.prepareCheckout.mockImplementationOnce(
      (repoPath, path, _base, reason, options, _barrier, operation) => {
        operation.setDiscard((cleanupOptions) =>
          mocks.discard(repoPath, path, cleanupOptions, reason, null)
        )
        signal = options.signal
        return new Promise<void>((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
        })
      }
    )
    const obsolete = prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    const settled = Promise.allSettled([obsolete])
    await flushBackgroundWork()
    const obsoletePath = mocks.prepareCheckout.mock.calls[0][1]
    for (const base of ['origin/one', 'origin/two', 'origin/three']) {
      await prepareWorktreeCreateForRepo(store, repo, base)
    }
    expect(signal?.aborted).toBe(true)
    expect((await settled)[0].status).toBe('rejected')
    await flushBackgroundWork()
    expect(mocks.discard).toHaveBeenCalledWith(
      repo.path,
      obsoletePath,
      expect.objectContaining({ signal: undefined }),
      expect.any(String),
      null
    )
  })

  it('does not start obsolete checkout work after shared cleanup finishes', async () => {
    let releaseCleanup!: () => void
    mocks.listWorktreeGraph.mockImplementationOnce(
      () =>
        new Promise<[]>((resolve) => {
          releaseCleanup = () => resolve([])
        })
    )
    const requests = ['main', 'one', 'two', 'three'].map((base) =>
      prepareWorktreeCreateForRepo(store, repo, `origin/${base}`)
    )
    const settled = Promise.allSettled(requests)
    await flushBackgroundWork()
    expect(mocks.prepareCheckout).not.toHaveBeenCalled()
    releaseCleanup()
    const results = await settled
    expect(results.map((result) => result.status)).toEqual([
      'rejected',
      'fulfilled',
      'fulfilled',
      'fulfilled'
    ])
    for (const base of ['one', 'two', 'three']) {
      await expect(
        consumePreparedWorktreeCreate({
          repoPath: repo.path,
          workspaceRoot: '/workspace',
          worktreePath: `/workspace/${base}`,
          branch: base,
          baseBranch: `origin/${base}`
        })
      ).resolves.toMatchObject({ status: 'hit' })
    }
    expect(mocks.prepareCheckout).not.toHaveBeenCalledWith(
      repo.path,
      expect.any(String),
      'refs/remotes/origin/main',
      expect.any(String),
      expect.anything(),
      undefined,
      expect.anything()
    )
    await flushBackgroundWork()
    expect(mocks.discard).not.toHaveBeenCalled()
  })

  it('keeps a claimed in-flight checkout alive when new preparations fill the pool', async () => {
    let signal: AbortSignal | undefined
    let finishCheckout!: () => void
    mocks.prepareCheckout.mockImplementationOnce((_repo, _path, _base, _lock, options) => {
      signal = options.signal
      return new Promise<void>((resolve) => {
        finishCheckout = resolve
      })
    })
    const preparation = prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    await flushBackgroundWork()
    const create = consumePreparedWorktreeCreate({
      repoPath: repo.path,
      workspaceRoot: '/workspace',
      worktreePath: '/workspace/claimed',
      branch: 'claimed',
      baseBranch: 'origin/main'
    })
    await flushBackgroundWork()
    for (const base of ['origin/one', 'origin/two', 'origin/three', 'origin/four']) {
      await prepareWorktreeCreateForRepo(store, repo, base)
    }
    expect(signal?.aborted).toBe(false)
    finishCheckout()
    await preparation
    expect(await create).toMatchObject({ status: 'hit' })
  })

  it('cancels an expired in-flight checkout', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    mocks.prepareCheckout.mockImplementationOnce((_repo, _path, _base, _lock, options) => {
      signal = options.signal
      return new Promise<void>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
      })
    })
    try {
      const settled = Promise.allSettled([prepareWorktreeCreateForRepo(store, repo, 'origin/main')])
      await vi.advanceTimersByTimeAsync(0)
      expect(signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(WORKTREE_CREATE_PREPARATION_TTL_MS)
      expect(signal?.aborted).toBe(true)
      expect((await settled)[0].status).toBe('rejected')
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves caller cancellation without mutating its options', async () => {
    const controller = new AbortController()
    const options = { signal: controller.signal }
    mocks.getWorktreeOptions.mockReturnValue(options)
    let signal: AbortSignal | undefined
    mocks.prepareCheckout.mockImplementationOnce((_repo, _path, _base, _lock, executionOptions) => {
      signal = executionOptions.signal
      return new Promise<void>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
      })
    })
    const preparation = prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    const settled = Promise.allSettled([preparation])
    await flushBackgroundWork()
    controller.abort()
    expect(signal?.aborted).toBe(true)
    expect((await settled)[0].status).toBe('rejected')
    expect(options.signal).toBe(controller.signal)
    expect(signal).not.toBe(controller.signal)
  })
})
