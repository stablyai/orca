import { beforeEach, describe, expect, it, vi } from 'vitest'

const { detectSparseCheckoutMock } = vi.hoisted(() => ({
  detectSparseCheckoutMock: vi.fn()
}))

vi.mock('./worktree-sparse-state', () => ({
  detectSparseCheckout: detectSparseCheckoutMock,
  resolveGitCommonDir: vi.fn()
}))

import {
  __getSparseCheckoutStateCacheSizeForTests,
  __resetSparseCheckoutStateCacheForTests,
  clearSparseCheckoutStateCache,
  detectSparseCheckoutCached,
  invalidateSparseCheckoutState
} from './worktree-sparse-checkout-cache'

beforeEach(() => {
  detectSparseCheckoutMock.mockReset()
  __resetSparseCheckoutStateCacheForTests()
})

describe('detectSparseCheckoutCached', () => {
  it('caches a detection result across repeated calls for the same path', async () => {
    detectSparseCheckoutMock.mockResolvedValue(true)

    expect(await detectSparseCheckoutCached('/repo/wt-a')).toBe(true)
    expect(await detectSparseCheckoutCached('/repo/wt-a')).toBe(true)

    expect(detectSparseCheckoutMock).toHaveBeenCalledTimes(1)
  })

  it('detects each distinct worktree path independently', async () => {
    detectSparseCheckoutMock.mockImplementation(
      async (worktreePath: string) => worktreePath === '/repo/wt-sparse'
    )

    expect(await detectSparseCheckoutCached('/repo/wt-sparse')).toBe(true)
    expect(await detectSparseCheckoutCached('/repo/wt-full')).toBe(false)
    expect(detectSparseCheckoutMock).toHaveBeenCalledTimes(2)
  })

  it('caches a false result too, so a worktree that stays non-sparse costs one detect', async () => {
    detectSparseCheckoutMock.mockResolvedValue(false)

    expect(await detectSparseCheckoutCached('/repo/wt-a')).toBe(false)
    expect(await detectSparseCheckoutCached('/repo/wt-a')).toBe(false)

    expect(detectSparseCheckoutMock).toHaveBeenCalledTimes(1)
  })

  it('re-detects once the reconcile window elapses, bounding staleness from unwitnessed external edits', async () => {
    vi.useFakeTimers()
    try {
      detectSparseCheckoutMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true)

      expect(await detectSparseCheckoutCached('/repo/wt-a')).toBe(false)

      // Just under the 5-minute reconcile window: still trusts the cached value.
      vi.advanceTimersByTime(5 * 60_000 - 1)
      expect(await detectSparseCheckoutCached('/repo/wt-a')).toBe(false)
      expect(detectSparseCheckoutMock).toHaveBeenCalledTimes(1)

      // Past the window: re-detects and picks up the external toggle.
      vi.advanceTimersByTime(2)
      expect(await detectSparseCheckoutCached('/repo/wt-a')).toBe(true)
      expect(detectSparseCheckoutMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('invalidateSparseCheckoutState', () => {
  it('drops only the named path, leaving other cached paths untouched', async () => {
    detectSparseCheckoutMock.mockResolvedValue(true)
    await detectSparseCheckoutCached('/repo/wt-a')
    await detectSparseCheckoutCached('/repo/wt-b')

    invalidateSparseCheckoutState('/repo/wt-a')
    expect(__getSparseCheckoutStateCacheSizeForTests()).toBe(1)

    detectSparseCheckoutMock.mockClear()
    await detectSparseCheckoutCached('/repo/wt-a')
    await detectSparseCheckoutCached('/repo/wt-b')
    expect(detectSparseCheckoutMock).toHaveBeenCalledTimes(1)
    expect(detectSparseCheckoutMock).toHaveBeenCalledWith('/repo/wt-a')
  })
})

describe('clearSparseCheckoutStateCache', () => {
  it('drops every cached path, matching the blunt clear-all used on any worktree-change notification', async () => {
    detectSparseCheckoutMock.mockResolvedValue(true)
    await detectSparseCheckoutCached('/repo/wt-a')
    await detectSparseCheckoutCached('/repo/wt-b')
    expect(__getSparseCheckoutStateCacheSizeForTests()).toBe(2)

    clearSparseCheckoutStateCache()

    expect(__getSparseCheckoutStateCacheSizeForTests()).toBe(0)
  })
})
