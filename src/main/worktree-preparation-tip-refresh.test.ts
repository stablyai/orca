import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { flushBackgroundWork, mocks, repo, store } from './__mocks__/worktree-create-preparation'
import { WorktreePreparationLockOwnershipError } from './git/worktree-preparation-lock'
import {
  consumePreparedWorktreeCreate,
  prepareWorktreeCreateForRepo
} from './worktree-create-preparation'
import {
  listPreparations,
  startPreparation,
  WORKTREE_CREATE_PREPARATION_TTL_MS
} from './worktree-create-preparation-pool'

const beforeMaterialization = Promise.resolve()

function consume() {
  return consumePreparedWorktreeCreate({
    repoPath: repo.path,
    workspaceRoot: '/workspace',
    worktreePath: '/workspace/new',
    branch: 'new',
    baseBranch: 'origin/main'
  })
}

describe('prepared checkout tip refresh', () => {
  it('refreshes the existing checkout on its Git host without preparing another tree', async () => {
    mocks.getWorktreeOptions.mockReturnValue({ wslDistro: 'Ubuntu' })
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    const entry = listPreparations()[0]!
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main', beforeMaterialization)
    expect(mocks.prepareCheckout).toHaveBeenCalledOnce()
    expect(mocks.refreshTip).toHaveBeenCalledWith(
      repo.path,
      entry.preparedPath,
      'refs/remotes/origin/main',
      entry.lockReason,
      { wslDistro: 'Ubuntu', signal: expect.any(AbortSignal) }
    )
  })

  it('lets consume join an in-flight refresh before finalizing', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    let release!: () => void
    mocks.refreshTip.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve))
    )
    const refresh = prepareWorktreeCreateForRepo(store, repo, 'origin/main', beforeMaterialization)
    await vi.waitFor(() => expect(mocks.refreshTip).toHaveBeenCalledOnce())
    const create = consume()
    await flushBackgroundWork()
    expect(mocks.finalize).not.toHaveBeenCalled()
    release()
    await refresh
    expect(await create).toMatchObject({ status: 'hit' })
    expect(mocks.finalize).toHaveBeenCalledOnce()
  })

  it('defers another preparation while the previous checkout is still claimed', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    expect(await consume()).toMatchObject({ status: 'hit' })
    mocks.computeWorkspaceRootAsync.mockClear()
    mocks.resolveBaseRef.mockClear()
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main', beforeMaterialization)
    expect(mocks.computeWorkspaceRootAsync).toHaveBeenCalledOnce()
    expect(mocks.resolveBaseRef).toHaveBeenCalledOnce()
    expect(mocks.refreshTip).not.toHaveBeenCalled()
    expect(mocks.prepareCheckout).toHaveBeenCalledOnce()
  })

  it('cancels an expired tip refresh before cleanup', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    try {
      await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
      const entry = listPreparations()[0]!
      mocks.refreshTip.mockImplementationOnce((_repo, _path, _base, _lock, options) => {
        signal = options.signal
        return new Promise<void>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true
          })
        })
      })
      const refresh = prepareWorktreeCreateForRepo(
        store,
        repo,
        'origin/main',
        beforeMaterialization
      )
      const settled = Promise.allSettled([refresh])
      await vi.advanceTimersByTimeAsync(0)
      expect(signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(WORKTREE_CREATE_PREPARATION_TTL_MS)
      expect(signal?.aborted).toBe(true)
      expect((await settled)[0]?.status).toBe('rejected')
      expect(mocks.discard).toHaveBeenCalledOnce()
      expect(mocks.discard).toHaveBeenCalledWith(
        repo.path,
        entry.preparedPath,
        {},
        entry.lockReason
      )
      expect(listPreparations()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels an evicted tip refresh and preserves its original cleanup scope', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    const entry = listPreparations()[0]!
    let signal: AbortSignal | undefined
    mocks.refreshTip.mockImplementationOnce((_repo, _path, _base, _lock, options) => {
      signal = options.signal
      return new Promise<void>((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true
        })
      })
    })
    const settled = Promise.allSettled([
      prepareWorktreeCreateForRepo(store, repo, 'origin/main', beforeMaterialization)
    ])
    await vi.waitFor(() => expect(mocks.refreshTip).toHaveBeenCalledOnce())
    for (const base of ['origin/one', 'origin/two', 'origin/three']) {
      await prepareWorktreeCreateForRepo(store, repo, base)
    }
    expect(signal?.aborted).toBe(true)
    expect((await settled)[0]?.status).toBe('rejected')
    await flushBackgroundWork()
    expect(mocks.discard).toHaveBeenCalledOnce()
    expect(mocks.discard).toHaveBeenCalledWith(repo.path, entry.preparedPath, {}, entry.lockReason)
  })

  it('preserves a checkout whose lock was taken over', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    mocks.refreshTip.mockRejectedValueOnce(new WorktreePreparationLockOwnershipError())
    await expect(
      prepareWorktreeCreateForRepo(store, repo, 'origin/main', beforeMaterialization)
    ).rejects.toThrow('lock owner changed')
    await flushBackgroundWork()
    expect(listPreparations()).toEqual([])
    expect(mocks.discard).not.toHaveBeenCalled()
    expect(await consume()).toMatchObject({ status: 'miss', reason: 'none_armed' })
  })

  it('serializes successive fetched tips and lets consume wait for the newest queued refresh', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    const order: string[] = []
    let release!: () => void
    mocks.refreshTip
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = () => {
              order.push('first-tip')
              resolve()
            }
          })
      )
      .mockImplementationOnce(async () => {
        order.push('second-tip')
      })
    mocks.finalize.mockImplementationOnce(async () => {
      order.push('finalize')
      return {}
    })
    const first = prepareWorktreeCreateForRepo(store, repo, 'origin/main', beforeMaterialization)
    await vi.waitFor(() => expect(mocks.refreshTip).toHaveBeenCalledOnce())
    const second = prepareWorktreeCreateForRepo(store, repo, 'origin/main', beforeMaterialization)
    await flushBackgroundWork()
    const create = consume()
    await flushBackgroundWork()
    expect(mocks.refreshTip).toHaveBeenCalledOnce()
    expect(mocks.finalize).not.toHaveBeenCalled()
    release()
    const results = await Promise.all([first, second, create])
    expect(results[2]).toMatchObject({ status: 'hit' })
    expect(order).toEqual(['first-tip', 'second-tip', 'finalize'])
    expect(mocks.prepareCheckout).toHaveBeenCalledOnce()
  })

  it('discards a claimed checkout once when successive queued refreshes fail', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    let rejectRefresh = (_error: Error) => {}
    mocks.refreshTip.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectRefresh = reject
        })
    )
    const first = prepareWorktreeCreateForRepo(store, repo, 'origin/main', beforeMaterialization)
    await vi.waitFor(() => expect(mocks.refreshTip).toHaveBeenCalledOnce())
    const second = prepareWorktreeCreateForRepo(store, repo, 'origin/main', beforeMaterialization)
    await flushBackgroundWork()
    const create = consume()
    const settled = Promise.allSettled([first, second])
    await flushBackgroundWork()
    const finishes: (() => void)[] = []
    mocks.discard.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishes.push(resolve)
        })
    )
    rejectRefresh(new Error('first tip reset failed'))
    await settled
    const attempt = await create
    expect(attempt).toMatchObject({ status: 'miss', reason: 'prepare_failed' })
    await vi.waitFor(() => expect(mocks.discard).toHaveBeenCalled())
    await flushBackgroundWork()
    try {
      expect(mocks.discard).toHaveBeenCalledOnce()
      expect(mocks.finalize).not.toHaveBeenCalled()
    } finally {
      for (const finish of finishes) {
        finish()
      }
      if (attempt.status === 'miss') {
        attempt.rearm?.()
      }
      await flushBackgroundWork()
    }
  })
})

describe('prepared checkout timing across a tip refresh', () => {
  it('keeps the re-arm build time and measures idle time from the refreshed ready', async () => {
    let now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    onTestFinished(() => clock.mockRestore())
    const build = Promise.withResolvers<void>()
    mocks.prepareCheckout.mockReturnValueOnce(build.promise)
    const armed = startPreparation(
      {
        repoPath: repo.path,
        workspaceRoot: '/workspace',
        baseBranch: 'origin/main',
        canonicalBase: 'refs/remotes/origin/main',
        options: {}
      },
      'automatic'
    )
    await vi.waitFor(() => expect(mocks.prepareCheckout).toHaveBeenCalled())
    now = 40_000
    build.resolve()
    await armed

    // The dialog opens a minute later and refreshes the spare once a 2 s fetch settles.
    now = 100_000
    const fetch = Promise.withResolvers<void>()
    const refreshed = prepareWorktreeCreateForRepo(store, repo, 'origin/main', fetch.promise)
    await flushBackgroundWork()
    now = 102_000
    fetch.resolve()
    await refreshed
    now = 112_000

    await expect(consume()).resolves.toMatchObject({
      status: 'hit',
      origin: 'rearm_then_prefetch',
      buildMs: 40_000,
      idleMs: 10_000
    })
  })
})
