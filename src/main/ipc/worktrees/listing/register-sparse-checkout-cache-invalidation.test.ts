import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Store } from '../../../persistence/loading-store/store'
import { runWorktreeChangeInvalidators } from '../../worktree-change-invalidators'
import { registerSparseCheckoutCacheInvalidation } from './register-sparse-checkout-cache-invalidation'

const {
  clearSparseCheckoutStateCacheMock,
  clearSparseCheckoutStateCacheForRepoMock,
  onSparseCheckoutStateChangedMock,
  notifyWorktreesChangedMock
} = vi.hoisted(() => ({
  clearSparseCheckoutStateCacheMock: vi.fn(),
  clearSparseCheckoutStateCacheForRepoMock: vi.fn(),
  onSparseCheckoutStateChangedMock: vi.fn(),
  notifyWorktreesChangedMock: vi.fn()
}))

vi.mock('../../../git/worktree-sparse-checkout-cache', () => ({
  clearSparseCheckoutStateCache: clearSparseCheckoutStateCacheMock,
  clearSparseCheckoutStateCacheForRepo: clearSparseCheckoutStateCacheForRepoMock,
  onSparseCheckoutStateChanged: onSparseCheckoutStateChangedMock
}))

vi.mock('../../worktree-remote', () => ({
  notifyWorktreesChanged: notifyWorktreesChangedMock
}))

function makeStore(repos: Repo[]): Store {
  return {
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getRepos: () => repos
  } as unknown as Store
}

const mainWindow = {} as never

beforeEach(() => {
  vi.clearAllMocks()
})

describe('registerSparseCheckoutCacheInvalidation', () => {
  it('clears only the resolved repo`s cache when the invalidator registry fires', () => {
    const store = makeStore([{ id: 'repo-1', path: '/repo-1' } as Repo])
    const dispose = registerSparseCheckoutCacheInvalidation(mainWindow, store)
    try {
      runWorktreeChangeInvalidators('repo-1')
      expect(clearSparseCheckoutStateCacheForRepoMock).toHaveBeenCalledWith('/repo-1')
      expect(clearSparseCheckoutStateCacheMock).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  })

  it('falls back to a full clear when the repo cannot be resolved', () => {
    const store = makeStore([])
    const dispose = registerSparseCheckoutCacheInvalidation(mainWindow, store)
    try {
      runWorktreeChangeInvalidators('unknown-repo')
      expect(clearSparseCheckoutStateCacheMock).toHaveBeenCalledTimes(1)
      expect(clearSparseCheckoutStateCacheForRepoMock).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  })

  it('forwards a background stale-while-revalidate flip to the shared worktrees-changed notification', () => {
    const store = makeStore([{ id: 'repo-1', path: '/repo-1' } as Repo])
    const dispose = registerSparseCheckoutCacheInvalidation(mainWindow, store)
    try {
      const listener = onSparseCheckoutStateChangedMock.mock.calls.at(-1)?.[0]
      listener?.('/repo-1', '/repo-1/wt-a', true)
      expect(notifyWorktreesChangedMock).toHaveBeenCalledWith(mainWindow, 'repo-1')
    } finally {
      dispose()
    }
  })

  it('drops the change listener on disposal so a stale window/store stops receiving flips', () => {
    const store = makeStore([{ id: 'repo-1', path: '/repo-1' } as Repo])
    const dispose = registerSparseCheckoutCacheInvalidation(mainWindow, store)
    dispose()
    expect(onSparseCheckoutStateChangedMock).toHaveBeenLastCalledWith(undefined)
  })
})
