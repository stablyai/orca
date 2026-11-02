import { describe, expect, it, vi } from 'vitest'
import { waitForPromiseWithSignal } from '../shared/abort-signal-reason'
import { flushBackgroundWork, mocks, repo, store } from './__mocks__/worktree-create-preparation'
import {
  consumePreparedWorktreeCreate,
  prepareWorktreeCreateForRepo
} from './worktree-create-preparation'
import {
  listPreparations,
  WORKTREE_CREATE_PREPARATION_TTL_MS
} from './worktree-create-preparation-pool'

function deferredFetch() {
  let settle!: () => void
  const beforeMaterialization = new Promise<void>((resolve) => {
    settle = resolve
  })
  return { beforeMaterialization, settle }
}

function consume() {
  return consumePreparedWorktreeCreate({
    repoPath: repo.path,
    workspaceRoot: '/workspace',
    worktreePath: '/workspace/new',
    branch: 'new',
    baseBranch: 'origin/main'
  })
}

describe('prepared checkout shared fetch barrier', () => {
  it('passes initial materialization settlement separately from owning WSL Git options', async () => {
    mocks.getWorktreeOptions.mockReturnValue({ wslDistro: 'Ubuntu' })
    const fetch = deferredFetch()
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main', fetch.beforeMaterialization)
    const entry = listPreparations()[0]!
    expect(mocks.prepareCheckout).toHaveBeenCalledWith(
      repo.path,
      entry.preparedPath,
      'refs/remotes/origin/main',
      entry.lockReason,
      { wslDistro: 'Ubuntu', signal: expect.any(AbortSignal) },
      fetch.beforeMaterialization
    )
    expect(mocks.refreshTip).not.toHaveBeenCalled()
    fetch.settle()
  })

  it('lets a cold racing consume join the first materialization without a second checkout or refresh', async () => {
    const fetch = deferredFetch()
    let materializations = 0
    mocks.prepareCheckout.mockImplementationOnce(
      async (_repo, _path, _base, _lock, options, barrier) => {
        await waitForPromiseWithSignal(barrier, options.signal)
        materializations++
      }
    )
    const preparation = prepareWorktreeCreateForRepo(
      store,
      repo,
      'origin/main',
      fetch.beforeMaterialization
    )
    await vi.waitFor(() => expect(mocks.prepareCheckout).toHaveBeenCalledOnce())
    const create = consume()
    await flushBackgroundWork()
    expect(materializations).toBe(0)
    expect(mocks.finalize).not.toHaveBeenCalled()
    fetch.settle()
    await preparation
    expect(await create).toMatchObject({ status: 'hit' })
    expect(materializations).toBe(1)
    expect(mocks.prepareCheckout).toHaveBeenCalledOnce()
    expect(mocks.refreshTip).not.toHaveBeenCalled()
    expect(mocks.finalize).toHaveBeenCalledOnce()
  })

  it('publishes an existing checkout refresh before a racing consume can finalize', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    const entry = listPreparations()[0]!
    const oldReady = entry.ready
    const fetch = deferredFetch()
    const preparation = prepareWorktreeCreateForRepo(
      store,
      repo,
      'origin/main',
      fetch.beforeMaterialization
    )
    await vi.waitFor(() => expect(entry.ready).not.toBe(oldReady))
    const create = consume()
    await flushBackgroundWork()
    expect(mocks.refreshTip).not.toHaveBeenCalled()
    expect(mocks.finalize).not.toHaveBeenCalled()
    fetch.settle()
    await preparation
    expect(await create).toMatchObject({ status: 'hit' })
    expect(mocks.prepareCheckout).toHaveBeenCalledOnce()
    expect(mocks.refreshTip).toHaveBeenCalledOnce()
    expect(mocks.finalize).toHaveBeenCalledOnce()
  })

  it('expires a ready checkout while its shared fetch is still pending without waiting for the network', async () => {
    vi.useFakeTimers()
    const fetch = deferredFetch()
    try {
      await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
      const entry = listPreparations()[0]!
      const settled = Promise.allSettled([
        prepareWorktreeCreateForRepo(store, repo, 'origin/main', fetch.beforeMaterialization)
      ])
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(WORKTREE_CREATE_PREPARATION_TTL_MS)
      expect((await settled)[0]?.status).toBe('rejected')
      expect(mocks.refreshTip).not.toHaveBeenCalled()
      expect(mocks.discard).toHaveBeenCalledOnce()
      expect(mocks.discard).toHaveBeenCalledWith(
        repo.path,
        entry.preparedPath,
        {},
        entry.lockReason
      )
      expect(listPreparations()).toEqual([])
    } finally {
      fetch.settle()
      vi.useRealTimers()
    }
  })
})
