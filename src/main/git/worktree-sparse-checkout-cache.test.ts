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
  clearSparseCheckoutStateCacheForRepo,
  detectSparseCheckoutCached,
  invalidateSparseCheckoutState,
  MAX_SPARSE_CHECKOUT_CACHE_ENTRIES,
  onSparseCheckoutStateChanged
} from './worktree-sparse-checkout-cache'

const RECONCILE_WINDOW_MS = 5 * 60_000

// Flush background microtasks with a real timer while Date.now remains controlled by the spy.
async function flushBackgroundRevalidation(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  detectSparseCheckoutMock.mockReset()
  __resetSparseCheckoutStateCacheForTests()
})

describe('detectSparseCheckoutCached', () => {
  it('bounds cache growth when worktree paths churn', async () => {
    detectSparseCheckoutMock.mockResolvedValue(true)

    for (let index = 0; index < MAX_SPARSE_CHECKOUT_CACHE_ENTRIES + 4; index += 1) {
      await detectSparseCheckoutCached('/repo', `/repo/worktree-${index}`)
    }

    expect(__getSparseCheckoutStateCacheSizeForTests()).toBe(MAX_SPARSE_CHECKOUT_CACHE_ENTRIES)
  })

  it('caches a detection result across repeated calls for the same repo+path', async () => {
    detectSparseCheckoutMock.mockResolvedValue(true)

    expect(await detectSparseCheckoutCached('/repo', '/repo/wt-a')).toBe(true)
    expect(await detectSparseCheckoutCached('/repo', '/repo/wt-a')).toBe(true)

    expect(detectSparseCheckoutMock).toHaveBeenCalledTimes(1)
  })

  it('detects each distinct worktree path independently', async () => {
    detectSparseCheckoutMock.mockImplementation(
      async (worktreePath: string) => worktreePath === '/repo/wt-sparse'
    )

    expect(await detectSparseCheckoutCached('/repo', '/repo/wt-sparse')).toBe(true)
    expect(await detectSparseCheckoutCached('/repo', '/repo/wt-full')).toBe(false)
    expect(detectSparseCheckoutMock).toHaveBeenCalledTimes(2)
  })

  it('scopes the cache by repo, so the same path under two repos is detected independently', async () => {
    detectSparseCheckoutMock.mockResolvedValue(true)

    expect(await detectSparseCheckoutCached('/repo-a', '/shared-mount/wt')).toBe(true)
    expect(await detectSparseCheckoutCached('/repo-b', '/shared-mount/wt')).toBe(true)

    expect(detectSparseCheckoutMock).toHaveBeenCalledTimes(2)
  })

  it('treats an equivalent path spelling (trailing slash, redundant segment) as the same cache entry', async () => {
    detectSparseCheckoutMock.mockResolvedValue(true)

    expect(await detectSparseCheckoutCached('/repo', '/repo/wt-a')).toBe(true)
    expect(await detectSparseCheckoutCached('/repo', '/repo/./wt-a/')).toBe(true)

    expect(detectSparseCheckoutMock).toHaveBeenCalledTimes(1)
  })

  it('caches a false result too, so a worktree that stays non-sparse costs one detect', async () => {
    detectSparseCheckoutMock.mockResolvedValue(false)

    expect(await detectSparseCheckoutCached('/repo', '/repo/wt-a')).toBe(false)
    expect(await detectSparseCheckoutCached('/repo', '/repo/wt-a')).toBe(false)

    expect(detectSparseCheckoutMock).toHaveBeenCalledTimes(1)
  })

  it('serves the stale value immediately past the reconcile window and corrects it in the background', async () => {
    const nowSpy = vi.spyOn(Date, 'now')
    try {
      nowSpy.mockReturnValue(1_000)
      detectSparseCheckoutMock.mockResolvedValueOnce(false)
      expect(await detectSparseCheckoutCached('/repo', '/repo/wt-a')).toBe(false)

      nowSpy.mockReturnValue(1_000 + RECONCILE_WINDOW_MS - 1)
      expect(await detectSparseCheckoutCached('/repo', '/repo/wt-a')).toBe(false)
      expect(detectSparseCheckoutMock).toHaveBeenCalledTimes(1)

      // Issue both stale reads before yielding so background revalidation cannot win the second read.
      nowSpy.mockReturnValue(1_000 + RECONCILE_WINDOW_MS + 1)
      detectSparseCheckoutMock.mockResolvedValueOnce(true)
      const firstPastWindow = detectSparseCheckoutCached('/repo', '/repo/wt-a')
      const secondPastWindow = detectSparseCheckoutCached('/repo', '/repo/wt-a')
      expect(await firstPastWindow).toBe(false)
      expect(await secondPastWindow).toBe(false)
      expect(detectSparseCheckoutMock).toHaveBeenCalledTimes(2)

      await flushBackgroundRevalidation()

      expect(await detectSparseCheckoutCached('/repo', '/repo/wt-a')).toBe(true)
      expect(detectSparseCheckoutMock).toHaveBeenCalledTimes(2)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('does not resurrect an entry that was explicitly invalidated while a background revalidation was in flight', async () => {
    const nowSpy = vi.spyOn(Date, 'now')
    let resolveDetect: (isSparse: boolean) => void = () => {}
    try {
      nowSpy.mockReturnValue(1_000)
      detectSparseCheckoutMock.mockResolvedValueOnce(false)
      await detectSparseCheckoutCached('/repo', '/repo/wt-a')

      nowSpy.mockReturnValue(1_000 + RECONCILE_WINDOW_MS + 1)
      detectSparseCheckoutMock.mockImplementationOnce(
        () => new Promise<boolean>((resolve) => (resolveDetect = resolve))
      )
      await detectSparseCheckoutCached('/repo', '/repo/wt-a')

      invalidateSparseCheckoutState('/repo', '/repo/wt-a')
      expect(__getSparseCheckoutStateCacheSizeForTests()).toBe(0)

      resolveDetect(true)
      await flushBackgroundRevalidation()
      expect(__getSparseCheckoutStateCacheSizeForTests()).toBe(0)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('does not let a stale in-flight revalidation clobber a fresh value written after remove+recreate at the same path', async () => {
    const nowSpy = vi.spyOn(Date, 'now')
    let resolveStaleDetect: (isSparse: boolean) => void = () => {}
    try {
      nowSpy.mockReturnValue(1_000)
      detectSparseCheckoutMock.mockResolvedValueOnce(false)
      await detectSparseCheckoutCached('/repo', '/repo/wt-a')

      // Hold a stale probe across removal and recreation at the same path.
      nowSpy.mockReturnValue(1_000 + RECONCILE_WINDOW_MS + 1)
      detectSparseCheckoutMock.mockImplementationOnce(
        () => new Promise<boolean>((resolve) => (resolveStaleDetect = resolve))
      )
      await detectSparseCheckoutCached('/repo', '/repo/wt-a')

      invalidateSparseCheckoutState('/repo', '/repo/wt-a')
      detectSparseCheckoutMock.mockResolvedValueOnce(true)
      expect(await detectSparseCheckoutCached('/repo', '/repo/wt-a')).toBe(true)

      // A presence-only guard would overwrite the recreated entry; require the original entry identity.
      resolveStaleDetect(false)
      await flushBackgroundRevalidation()
      expect(await detectSparseCheckoutCached('/repo', '/repo/wt-a')).toBe(true)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('notifies the registered change listener only when a background revalidation flips the answer', async () => {
    const listener = vi.fn()
    onSparseCheckoutStateChanged(listener)
    const nowSpy = vi.spyOn(Date, 'now')
    try {
      nowSpy.mockReturnValue(1_000)
      detectSparseCheckoutMock.mockResolvedValueOnce(false)
      await detectSparseCheckoutCached('/repo', '/repo/wt-a')

      nowSpy.mockReturnValue(1_000 + RECONCILE_WINDOW_MS + 1)
      detectSparseCheckoutMock.mockResolvedValueOnce(false)
      await detectSparseCheckoutCached('/repo', '/repo/wt-a')
      await flushBackgroundRevalidation()
      expect(listener).not.toHaveBeenCalled()

      nowSpy.mockReturnValue(1_000 + 2 * RECONCILE_WINDOW_MS + 2)
      detectSparseCheckoutMock.mockResolvedValueOnce(true)
      await detectSparseCheckoutCached('/repo', '/repo/wt-a')
      await flushBackgroundRevalidation()
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith('/repo', '/repo/wt-a', true)
    } finally {
      nowSpy.mockRestore()
      onSparseCheckoutStateChanged(undefined)
    }
  })
})

describe('invalidateSparseCheckoutState', () => {
  it('drops only the named repo+path, leaving other cached paths untouched', async () => {
    detectSparseCheckoutMock.mockResolvedValue(true)
    await detectSparseCheckoutCached('/repo', '/repo/wt-a')
    await detectSparseCheckoutCached('/repo', '/repo/wt-b')

    invalidateSparseCheckoutState('/repo', '/repo/wt-a')
    expect(__getSparseCheckoutStateCacheSizeForTests()).toBe(1)

    detectSparseCheckoutMock.mockClear()
    await detectSparseCheckoutCached('/repo', '/repo/wt-a')
    await detectSparseCheckoutCached('/repo', '/repo/wt-b')
    expect(detectSparseCheckoutMock).toHaveBeenCalledTimes(1)
    expect(detectSparseCheckoutMock).toHaveBeenCalledWith('/repo/wt-a', {})
  })
})

describe('clearSparseCheckoutStateCacheForRepo', () => {
  it('drops only the named repo`s entries, leaving a sibling repo`s warm cache intact', async () => {
    detectSparseCheckoutMock.mockResolvedValue(true)
    await detectSparseCheckoutCached('/repo-a', '/repo-a/wt-1')
    await detectSparseCheckoutCached('/repo-b', '/repo-b/wt-1')
    expect(__getSparseCheckoutStateCacheSizeForTests()).toBe(2)

    clearSparseCheckoutStateCacheForRepo('/repo-a')
    expect(__getSparseCheckoutStateCacheSizeForTests()).toBe(1)

    detectSparseCheckoutMock.mockClear()
    await detectSparseCheckoutCached('/repo-a', '/repo-a/wt-1')
    await detectSparseCheckoutCached('/repo-b', '/repo-b/wt-1')
    expect(detectSparseCheckoutMock).toHaveBeenCalledTimes(1)
  })
})

describe('clearSparseCheckoutStateCache', () => {
  it('drops every cached path across every repo, matching the fallback used when a repo cannot be resolved', async () => {
    detectSparseCheckoutMock.mockResolvedValue(true)
    await detectSparseCheckoutCached('/repo-a', '/repo-a/wt-1')
    await detectSparseCheckoutCached('/repo-b', '/repo-b/wt-1')
    expect(__getSparseCheckoutStateCacheSizeForTests()).toBe(2)

    clearSparseCheckoutStateCache()

    expect(__getSparseCheckoutStateCacheSizeForTests()).toBe(0)
  })
})

// Distro-less and distro-carrying reads of one checkout must retain separate sparse answers.
describe('detectSparseCheckoutCached with a WSL distro', () => {
  // Model a non-drvfs pointer that requires the caller's distro to resolve.
  function detectOnlyWithDistro(distro: string): void {
    detectSparseCheckoutMock.mockImplementation(
      async (_worktreePath: string, options?: { wslDistro?: string }) =>
        options?.wslDistro === distro
    )
  }

  it('does not serve a distro-carrying read an answer derived without that distro', async () => {
    detectOnlyWithDistro('Ubuntu')

    expect(await detectSparseCheckoutCached('C:\\repo', 'C:\\repo\\wt')).toBe(false)
    expect(
      await detectSparseCheckoutCached('C:\\repo', 'C:\\repo\\wt', { wslDistro: 'Ubuntu' })
    ).toBe(true)

    expect(detectSparseCheckoutMock).toHaveBeenCalledTimes(2)
  })

  it('keeps a distro-carrying answer correct when a distro-less read follows it', async () => {
    detectOnlyWithDistro('Ubuntu')

    expect(
      await detectSparseCheckoutCached('C:\\repo', 'C:\\repo\\wt', { wslDistro: 'Ubuntu' })
    ).toBe(true)
    expect(await detectSparseCheckoutCached('C:\\repo', 'C:\\repo\\wt')).toBe(false)
    expect(
      await detectSparseCheckoutCached('C:\\repo', 'C:\\repo\\wt', { wslDistro: 'Ubuntu' })
    ).toBe(true)

    expect(detectSparseCheckoutMock).toHaveBeenCalledTimes(2)
  })

  it('treats distro spellings that name the same distro as one entry', async () => {
    detectSparseCheckoutMock.mockResolvedValue(true)

    expect(
      await detectSparseCheckoutCached('C:\\repo', 'C:\\repo\\wt', { wslDistro: 'Ubuntu' })
    ).toBe(true)
    expect(
      await detectSparseCheckoutCached('C:\\repo', 'C:\\repo\\wt', { wslDistro: ' ubuntu ' })
    ).toBe(true)

    expect(detectSparseCheckoutMock).toHaveBeenCalledTimes(1)
  })

  it('does not let a distro-less reader past the window revalidate a distro-carrying entry', async () => {
    const listener = vi.fn()
    onSparseCheckoutStateChanged(listener)
    const nowSpy = vi.spyOn(Date, 'now')
    try {
      detectOnlyWithDistro('Ubuntu')
      nowSpy.mockReturnValue(1_000)
      await detectSparseCheckoutCached('C:\\repo', 'C:\\repo\\wt', { wslDistro: 'Ubuntu' })
      await detectSparseCheckoutCached('C:\\repo', 'C:\\repo\\wt')

      // Revalidate only the distro-less entry, without flipping the other entry's sparse badge.
      nowSpy.mockReturnValue(1_000 + RECONCILE_WINDOW_MS + 1)
      expect(await detectSparseCheckoutCached('C:\\repo', 'C:\\repo\\wt')).toBe(false)
      await flushBackgroundRevalidation()

      expect(listener).not.toHaveBeenCalled()
      expect(
        await detectSparseCheckoutCached('C:\\repo', 'C:\\repo\\wt', { wslDistro: 'Ubuntu' })
      ).toBe(true)
    } finally {
      nowSpy.mockRestore()
      onSparseCheckoutStateChanged(undefined)
    }
  })

  it('drops every distro variant of a path on invalidate, so a removed worktree leaves nothing behind', async () => {
    detectSparseCheckoutMock.mockResolvedValue(true)
    await detectSparseCheckoutCached('C:\\repo', 'C:\\repo\\wt')
    await detectSparseCheckoutCached('C:\\repo', 'C:\\repo\\wt', { wslDistro: 'Ubuntu' })
    await detectSparseCheckoutCached('C:\\repo', 'C:\\repo\\other')
    expect(__getSparseCheckoutStateCacheSizeForTests()).toBe(3)

    invalidateSparseCheckoutState('C:\\repo', 'C:\\repo\\wt')

    expect(__getSparseCheckoutStateCacheSizeForTests()).toBe(1)
  })

  it('still caches normally with no distro anywhere, as on macOS/Linux and native Windows', async () => {
    detectSparseCheckoutMock.mockResolvedValue(true)

    expect(await detectSparseCheckoutCached('/repo', '/repo/wt-a')).toBe(true)
    expect(await detectSparseCheckoutCached('/repo', '/repo/wt-a', {})).toBe(true)
    expect(await detectSparseCheckoutCached('/repo', '/repo/wt-a', { wslDistro: undefined })).toBe(
      true
    )

    expect(detectSparseCheckoutMock).toHaveBeenCalledTimes(1)
    expect(__getSparseCheckoutStateCacheSizeForTests()).toBe(1)
  })
})
