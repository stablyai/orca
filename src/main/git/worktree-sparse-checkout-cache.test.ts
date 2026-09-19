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
  onSparseCheckoutStateChanged
} from './worktree-sparse-checkout-cache'

const RECONCILE_WINDOW_MS = 5 * 60_000

// A real setTimeout tick, not a faked one, to flush the microtask chain a background
// stale-while-revalidate detect runs on without needing vi.useFakeTimers() (which would also
// have to fake Date.now(), the thing these tests drive manually via the Date.now spy below).
async function flushBackgroundRevalidation(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  detectSparseCheckoutMock.mockReset()
  __resetSparseCheckoutStateCacheForTests()
})

describe('detectSparseCheckoutCached', () => {
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

      // Just under the window: still trusts the cached value, no re-detect.
      nowSpy.mockReturnValue(1_000 + RECONCILE_WINDOW_MS - 1)
      expect(await detectSparseCheckoutCached('/repo', '/repo/wt-a')).toBe(false)
      expect(detectSparseCheckoutMock).toHaveBeenCalledTimes(1)

      // Past the window: both calls return the (stale) cached value, and only one kicks a
      // background re-detect. Read both without awaiting in between — the underlying function
      // never suspends before returning the stale value, so two calls issued back-to-back in the
      // same tick are the only reliable way to observe "both concurrent callers stay stale" without
      // racing the background revalidation's own microtask.
      nowSpy.mockReturnValue(1_000 + RECONCILE_WINDOW_MS + 1)
      detectSparseCheckoutMock.mockResolvedValueOnce(true)
      const firstPastWindow = detectSparseCheckoutCached('/repo', '/repo/wt-a')
      const secondPastWindow = detectSparseCheckoutCached('/repo', '/repo/wt-a')
      expect(await firstPastWindow).toBe(false)
      expect(await secondPastWindow).toBe(false)
      expect(detectSparseCheckoutMock).toHaveBeenCalledTimes(2)

      await flushBackgroundRevalidation()

      // The corrected value is now served without needing another window to elapse.
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

      // Past the window: kicks a background re-detect that we hold open.
      nowSpy.mockReturnValue(1_000 + RECONCILE_WINDOW_MS + 1)
      detectSparseCheckoutMock.mockImplementationOnce(
        () => new Promise<boolean>((resolve) => (resolveDetect = resolve))
      )
      await detectSparseCheckoutCached('/repo', '/repo/wt-a')

      // The worktree is removed (or the repo cache is cleared) while the detect above is in flight.
      invalidateSparseCheckoutState('/repo', '/repo/wt-a')
      expect(__getSparseCheckoutStateCacheSizeForTests()).toBe(0)

      // The in-flight detect now resolves; it must not write the entry back.
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

      // Past the window: kicks a background re-detect that we hold open (simulates a slow probe
      // racing a worktree removal + recreation at the same path).
      nowSpy.mockReturnValue(1_000 + RECONCILE_WINDOW_MS + 1)
      detectSparseCheckoutMock.mockImplementationOnce(
        () => new Promise<boolean>((resolve) => (resolveStaleDetect = resolve))
      )
      await detectSparseCheckoutCached('/repo', '/repo/wt-a')

      // The worktree is removed (invalidate) and a new one is recreated at the exact same path,
      // repopulating the key with a fresh, different value via a normal cold read.
      invalidateSparseCheckoutState('/repo', '/repo/wt-a')
      detectSparseCheckoutMock.mockResolvedValueOnce(true)
      expect(await detectSparseCheckoutCached('/repo', '/repo/wt-a')).toBe(true)

      // The stale in-flight detect from before the remove+recreate now resolves with the old
      // answer. A presence-only guard would let this overwrite the fresh entry above; the fix
      // must compare entry identity and refuse to write back over a value it didn't produce.
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

// Regression coverage for the live Windows+WSL sequence: a distro-less listing (filesystem-auth
// root rebuild, worktree ownership checks) racing the real distro-carrying listing for the same
// repo. Before the distro joined the cache key they shared one entry, so whichever ran first
// decided the sparse badge for the whole reconcile window.
describe('detectSparseCheckoutCached with a WSL distro', () => {
  // Mirrors the real probe: without the distro the gitdir pointer resolves to a fabricated Win32
  // path, the sparse-checkout stat misses, and the worktree reads as non-sparse.
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

      // Past the window the distro-less caller re-probes its own entry, not the sparse one, so the
      // badge cannot blink off and fire the change listener that clears the whole repo's cache.
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
