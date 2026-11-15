import { describe, expect, it, vi } from 'vitest'
import { waitForPromiseWithSignal } from '../../../../shared/concurrency/abort-signal-reason'
import {
  flushBackgroundWork,
  mocks,
  repo,
  store
} from '../../../__mocks__/worktree-create-preparation'
import {
  consumePreparedWorktreeCreate,
  prepareWorktreeCreateForRepo
} from './worktree-create-preparation'

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
})
