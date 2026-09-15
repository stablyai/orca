import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WorktreeLogic from './ipc/worktree-logic'
import type { Store } from './persistence'
import { WORKTREE_CREATE_PREPARATION_TTL_MS } from './worktree-create-preparation-pool'
import type { Repo } from '../shared/repo-types'
import { resolveWorktreeAddBaseRef } from '../shared/worktree/base-ref'

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  listWorktreeGraph: vi.fn(),
  prepareCheckout: vi.fn(),
  finalize: vi.fn(),
  discard: vi.fn(),
  unlock: vi.fn(),
  getWorktreeOptions: vi.fn(),
  computeWorkspaceRoot: vi.fn(),
  computeWorkspaceRootAsync: vi.fn(),
  resolveBaseRef: vi.fn(),
  measureDivergence: vi.fn()
}))

vi.mock('node:fs/promises', () => ({ mkdir: mocks.mkdir }))
vi.mock('./git/worktree', () => ({ listWorktreeGraph: mocks.listWorktreeGraph }))
vi.mock('./git/worktree-create-preparation', () => ({
  prepareWorktreeCreateCheckout: mocks.prepareCheckout,
  finalizePreparedWorktree: mocks.finalize,
  discardPreparedWorktree: mocks.discard,
  unlockPreparedWorktree: mocks.unlock
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
vi.mock('./ipc/worktree-logic', async (importOriginal) => ({
  isOrphanedWorktreeError: (await importOriginal<typeof WorktreeLogic>()).isOrphanedWorktreeError,
  computeWorkspaceRoot: mocks.computeWorkspaceRoot,
  computeWorkspaceRootAsync: mocks.computeWorkspaceRootAsync,
  getWorktreePathSettings: () => ({
    workspaceDir: process.platform === 'win32' ? 'C:\\workspace' : '/workspace',
    nestWorkspaces: false
  })
}))

import {
  _resetWorktreeCreatePreparationsForTests,
  consumePreparedWorktreeCreate,
  prepareWorktreeCreateForRepo
} from './worktree-create-preparation'

// Evictions and retries are fire-and-forget, so let them settle before asserting.
function flushBackgroundWork(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const EXISTING_REFS = new Set([
  'refs/heads/main',
  'refs/remotes/origin/main',
  'refs/remotes/origin/release'
])
const repo = { id: 'repo-1', path: '/repo' } as Repo
const store = { getSettings: () => ({}) } as unknown as Store

beforeEach(() => {
  mocks.mkdir.mockReset().mockResolvedValue(undefined)
  mocks.listWorktreeGraph.mockReset().mockResolvedValue([])
  mocks.prepareCheckout.mockReset().mockResolvedValue(undefined)
  mocks.finalize.mockReset().mockResolvedValue({})
  mocks.discard.mockReset().mockResolvedValue(undefined)
  mocks.unlock.mockReset().mockResolvedValue(undefined)
  mocks.getWorktreeOptions.mockReset().mockReturnValue({})
  mocks.measureDivergence.mockReset().mockResolvedValue('within')
  mocks.resolveBaseRef
    .mockReset()
    .mockImplementation((_repoPath: string, baseRef: string) =>
      resolveWorktreeAddBaseRef(baseRef, async (candidate) => EXISTING_REFS.has(candidate))
    )
  mocks.computeWorkspaceRoot.mockReset().mockImplementation(() => {
    throw new Error('synchronous workspace-root lookup must not run on the main thread')
  })
  mocks.computeWorkspaceRootAsync
    .mockReset()
    .mockImplementation(async (repoPath: string) =>
      process.platform === 'win32' && /^[A-Za-z]:[\\/]/.test(repoPath)
        ? 'C:\\workspace'
        : '/workspace'
    )
})

afterEach(async () => {
  await _resetWorktreeCreatePreparationsForTests()
})

// Why this file exists separately from worktree-create-preparation.test.ts: it holds the
// in-flight checkout cancellation paths (eviction, expiry, caller abort) and the discard that
// follows, keeping both suites under the test-file line limit.
describe('worktree create preparation cancellation', () => {
  it('cancels an evicted checkout and cleans up with the original options', async () => {
    let signal: AbortSignal | undefined
    mocks.prepareCheckout.mockImplementationOnce((_repo, _path, _base, _lock, options) => {
      signal = options.signal
      return new Promise<void>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
      })
    })
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
    expect(mocks.discard).toHaveBeenCalledWith(repo.path, obsoletePath, {})
  })

  it('does not retry a discard whose registration the aborted checkout already removed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.prepareCheckout.mockImplementationOnce((_repo, _path, _base, _lock, options) => {
      const signal = options.signal!
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    try {
      const obsolete = prepareWorktreeCreateForRepo(store, repo, 'origin/main').catch(() => {})
      await flushBackgroundWork()
      const obsoletePath = mocks.prepareCheckout.mock.calls[0][1] as string
      mocks.discard.mockImplementation(async (_repoPath: string, path: string) => {
        if (path === obsoletePath) {
          throw Object.assign(new Error(`fatal: '${path}' is not a working tree`), {
            stderr: `fatal: '${path}' is not a working tree`
          })
        }
      })
      for (const base of ['origin/one', 'origin/two', 'origin/three']) {
        await prepareWorktreeCreateForRepo(store, repo, base)
      }
      await obsolete
      await flushBackgroundWork()
      const obsoleteDiscards = (): number =>
        mocks.discard.mock.calls.filter((call) => call[1] === obsoletePath).length
      expect(obsoleteDiscards()).toBe(1)

      for (const base of ['origin/four', 'origin/five']) {
        await prepareWorktreeCreateForRepo(store, repo, base)
        await flushBackgroundWork()
      }
      expect(obsoleteDiscards()).toBe(1)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
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
    expect(mocks.prepareCheckout).toHaveBeenCalledTimes(3)
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
