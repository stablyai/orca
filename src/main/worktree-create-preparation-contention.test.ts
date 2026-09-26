import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from './persistence'
import type { Repo } from '../shared/repo-types'
import type { AddWorktreeResult } from './git/worktree'

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  listWorktreeGraph: vi.fn(),
  prepare: vi.fn(),
  finalize: vi.fn(),
  discard: vi.fn(),
  computeWorkspaceRootAsync: vi.fn(),
  getWorktreeOptions: vi.fn(),
  resolveBaseRef: vi.fn(),
  measureDivergence: vi.fn()
}))

vi.mock('node:fs/promises', () => ({ mkdir: mocks.mkdir }))
vi.mock('./git/worktree', () => ({ listWorktreeGraph: mocks.listWorktreeGraph }))
vi.mock('./git/worktree-create-preparation', () => ({
  prepareWorktreeCreateCheckout: mocks.prepare,
  finalizePreparedWorktree: mocks.finalize,
  discardPreparedWorktree: mocks.discard,
  unlockPreparedWorktree: vi.fn()
}))
vi.mock('./git/worktree-base-ref-probe', () => ({
  resolveLocalWorktreeBaseRef: mocks.resolveBaseRef
}))
vi.mock('./git/worktree-base-divergence', () => ({
  measureRetargetDivergence: mocks.measureDivergence
}))
vi.mock('./project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: mocks.getWorktreeOptions,
  getWorktreeMirrorDistro: () => undefined
}))
vi.mock('./ipc/worktree-logic', () => ({
  computeWorkspaceRootAsync: mocks.computeWorkspaceRootAsync,
  getWorktreePathSettings: () => ({ workspaceDir: '/workspace', nestWorkspaces: false })
}))

import {
  _resetWorktreeCreatePreparationsForTests,
  consumePreparedWorktreeCreate,
  hasPendingWorktreeCreatePreparations,
  prepareWorktreeCreateForRepo
} from './worktree-create-preparation'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: 'blue',
  addedAt: 0
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The tested path reads only getSettings from Store.
const store = { getSettings: () => ({}) } as unknown as Store
const flushBackgroundWork = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function consume(baseBranch = 'origin/main') {
  return consumePreparedWorktreeCreate({
    repoPath: repo.path,
    workspaceRoot: '/workspace',
    worktreePath: '/workspace/new-worktree',
    branch: 'feature/new-worktree',
    baseBranch
  })
}

beforeEach(() => {
  mocks.mkdir.mockReset().mockResolvedValue(undefined)
  mocks.listWorktreeGraph.mockReset().mockResolvedValue([])
  mocks.prepare.mockReset().mockResolvedValue(undefined)
  mocks.finalize.mockReset().mockResolvedValue({})
  mocks.discard.mockReset().mockResolvedValue(undefined)
  mocks.computeWorkspaceRootAsync.mockReset().mockResolvedValue('/workspace')
  mocks.getWorktreeOptions.mockReset().mockReturnValue({})
  mocks.resolveBaseRef
    .mockReset()
    .mockImplementation(async (_path: string, base: string) =>
      base === 'main'
        ? 'refs/heads/main'
        : base === 'other/main'
          ? 'refs/remotes/other/main'
          : 'refs/remotes/origin/main'
    )
  mocks.measureDivergence.mockReset().mockResolvedValue('within')
})

afterEach(async () => {
  await _resetWorktreeCreatePreparationsForTests()
})

describe('claimed worktree preparation', () => {
  it('defers prefetch through checkout, finalization, and the remaining create work', async () => {
    const checkout = Promise.withResolvers<void>()
    const checkoutStarted = Promise.withResolvers<void>()
    const finalize = Promise.withResolvers<AddWorktreeResult>()
    const finalizeStarted = Promise.withResolvers<void>()
    mocks.prepare.mockImplementationOnce(() => {
      checkoutStarted.resolve()
      return checkout.promise
    })
    mocks.finalize.mockImplementationOnce(() => {
      finalizeStarted.resolve()
      return finalize.promise
    })
    const preparation = prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    await checkoutStarted.promise
    const create = consume()
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    expect(mocks.prepare).toHaveBeenCalledTimes(1)

    checkout.resolve()
    await preparation
    await finalizeStarted.promise
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    expect(mocks.prepare).toHaveBeenCalledTimes(1)

    finalize.resolve({})
    const result = await create
    expect(result.status).toBe('hit')
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    expect(mocks.prepare).toHaveBeenCalledTimes(1)
    result.rearm?.()
    await flushBackgroundWork()
    expect(mocks.prepare).toHaveBeenCalledTimes(2)
  })

  it('coalesces mid-create prefetches and releases once at create completion', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    const result = await consume()
    expect(result.status).toBe('hit')
    expect(hasPendingWorktreeCreatePreparations()).toBe(true)

    await Promise.all([
      prepareWorktreeCreateForRepo(store, repo, 'origin/main'),
      prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    ])
    expect(mocks.prepare).toHaveBeenCalledTimes(1)
    if (result.status === 'hit') {
      result.rearm()
      result.rearm()
    }
    await flushBackgroundWork()
    expect(mocks.prepare).toHaveBeenCalledTimes(2)
    expect(hasPendingWorktreeCreatePreparations()).toBe(true)
  })

  it('allows a fresh prefetch after an isolated create completes', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    const result = await consume()
    expect(result.status).toBe('hit')
    if (result.status === 'hit') {
      result.rearm()
    }
    expect(hasPendingWorktreeCreatePreparations()).toBe(false)

    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    expect(mocks.prepare).toHaveBeenCalledTimes(2)
  })

  it('does not repeat a burst replacement when release runs twice', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    const first = await consume()
    if (first.status === 'hit') {
      first.rearm()
    }
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    const second = await consume()
    expect(second.status).toBe('hit')
    if (second.status === 'hit') {
      second.rearm()
      second.rearm()
    }
    await flushBackgroundWork()
    expect(mocks.prepare).toHaveBeenCalledTimes(3)
  })

  it('reserves both the prepared and requested canonical bases on a retarget', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    const result = await consume('main')
    expect(result).toMatchObject({ status: 'hit', retargeted: true })

    await prepareWorktreeCreateForRepo(store, repo, 'main')
    expect(mocks.prepare).toHaveBeenCalledTimes(1)
    if (result.status === 'hit') {
      result.rearm()
    }
    await flushBackgroundWork()
    expect(mocks.prepare).toHaveBeenCalledTimes(2)
    expect(mocks.prepare.mock.calls[1]?.[2]).toBe('refs/heads/main')
  })

  it('preserves distinct prefetch bases while a retargeted create finishes', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    const result = await consume('main')
    expect(result.status).toBe('hit')

    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    await prepareWorktreeCreateForRepo(store, repo, 'main')
    expect(mocks.prepare).toHaveBeenCalledTimes(1)
    if (result.status === 'hit') {
      result.rearm()
    }
    await flushBackgroundWork()
    expect(mocks.prepare).toHaveBeenCalledTimes(3)
  })

  it('passes a pending prefetch to another create claiming the same requested base', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    await prepareWorktreeCreateForRepo(store, repo, 'other/main')
    const first = await consume('main')
    const second = await consume('main')
    expect(first.status).toBe('hit')
    expect(second.status).toBe('hit')

    await prepareWorktreeCreateForRepo(store, repo, 'main')
    expect(mocks.prepare).toHaveBeenCalledTimes(2)
    if (second.status === 'hit') {
      second.rearm()
    }
    await flushBackgroundWork()
    expect(mocks.prepare).toHaveBeenCalledTimes(2)
    if (first.status === 'hit') {
      first.rearm()
    }
    await flushBackgroundWork()
    expect(mocks.prepare).toHaveBeenCalledTimes(3)
  })

  it('keeps a burst replacement when the remaining claim is isolated', async () => {
    let timestamp = 1_000
    const now = vi.spyOn(Date, 'now').mockImplementation(() => timestamp++)
    try {
      await prepareWorktreeCreateForRepo(store, repo, 'other/main')
      const seed = await consume('other/main')
      expect(seed.status).toBe('hit')
      seed.rearm?.()

      await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
      await prepareWorktreeCreateForRepo(store, repo, 'other/main')
      const burst = await consume('main')
      const isolated = await consume('main')
      expect(burst).toMatchObject({ status: 'hit', retargeted: true })
      expect(isolated).toMatchObject({ status: 'hit', retargeted: true })
      expect(mocks.prepare).toHaveBeenCalledTimes(3)

      burst.rearm?.()
      await flushBackgroundWork()
      expect(mocks.prepare).toHaveBeenCalledTimes(3)
      isolated.rearm?.()
      await flushBackgroundWork()
      expect(mocks.prepare).toHaveBeenCalledTimes(4)
      expect(mocks.prepare.mock.calls[3]?.[2]).toBe('refs/heads/main')
    } finally {
      now.mockRestore()
    }
  })

  it('does not hold another repo, workspace root, or Git host behind the claim', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    const result = await consume()
    expect(result.status).toBe('hit')

    await prepareWorktreeCreateForRepo(store, { ...repo, path: '/other-repo' }, 'origin/main')
    mocks.computeWorkspaceRootAsync.mockResolvedValueOnce('/other-workspace')
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    mocks.getWorktreeOptions.mockReturnValue({ wslDistro: 'Ubuntu' })
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    expect(mocks.prepare).toHaveBeenCalledTimes(4)
    if (result.status === 'hit') {
      result.rearm()
    }
  })

  it('releases after failed finalization has discarded the claimed checkout', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    let failFinalization!: (error: Error) => void
    mocks.finalize.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        failFinalization = reject
      })
    )
    const create = consume()
    await flushBackgroundWork()
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    expect(mocks.prepare).toHaveBeenCalledTimes(1)

    failFinalization(new Error('finalize failed'))
    const result = await create
    expect(result).toMatchObject({ status: 'miss', reason: 'finalize_failed' })
    expect(mocks.discard).toHaveBeenCalledTimes(1)
    await flushBackgroundWork()
    expect(mocks.prepare).toHaveBeenCalledTimes(1)
    result.rearm?.()
    await flushBackgroundWork()
    expect(mocks.prepare).toHaveBeenCalledTimes(2)
  })

  it('holds an explicit prefetch through a claimed checkout failure', async () => {
    let failPreparation!: (error: Error) => void
    mocks.prepare.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        failPreparation = reject
      })
    )
    const initialPreparation = prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    const preparationFailure = initialPreparation.catch(() => {})
    await flushBackgroundWork()
    const create = consume()
    await flushBackgroundWork()
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    expect(mocks.prepare).toHaveBeenCalledTimes(1)

    failPreparation(new Error('checkout failed'))
    const result = await create
    await preparationFailure
    expect(result).toMatchObject({ status: 'miss', reason: 'prepare_failed' })
    expect(mocks.prepare).toHaveBeenCalledTimes(1)
    result.rearm?.()
    await flushBackgroundWork()
    expect(mocks.prepare).toHaveBeenCalledTimes(2)
  })
})
