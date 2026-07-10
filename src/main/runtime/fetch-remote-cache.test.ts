import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why: these tests cover the §3.3 Lifecycle rules on
// `OrcaRuntimeService.fetchRemoteWithCache` — in particular that a rejected
// fetch evicts its Map entry AND does not advance the freshness timestamp,
// and that two concurrent callers serialize on a single underlying fetch.
// They live in a dedicated file so we can mock `gitExecFileAsync` cleanly
// without disturbing the large orca-runtime.test.ts mock surface.

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn())

vi.mock('../git/runner', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    gitExecFileAsync: gitExecFileAsyncMock
  }
})

// Why: orca-runtime.ts imports heavy modules (hooks, ipc/*, etc.) at top
// level. We only exercise the fetch cache, so we let those imports load
// normally — none of them trigger IO until a runtime method is called.
import { OrcaRuntimeService } from './orca-runtime'

function fetchCallCount(): number {
  return gitExecFileAsyncMock.mock.calls.filter(
    ([argv]) => Array.isArray(argv) && argv[0] === 'fetch'
  ).length
}

function exactBaseRefreshOptions(cwd: string): {
  cwd: string
  timeout: number
  useConfiguredSshCommandForNetwork: boolean
} {
  return { cwd, timeout: 60_000, useConfiguredSshCommandForNetwork: true }
}

// Why (STA-1292): the broad create-path fetch must carry a timeout so a Windows
// credential-manager GUI hang can't wedge worktree creation forever.
function fullRemoteFetchOptions(cwd: string): { cwd: string; timeout: number } {
  return { cwd, timeout: 60_000 }
}

function mockFetchResults(results: (Promise<unknown> | unknown)[]): void {
  let fetchIndex = 0
  gitExecFileAsyncMock.mockImplementation((argv: string[]) => {
    if (argv[0] === 'rev-parse') {
      return Promise.reject(new Error('not a repo in cache-key test'))
    }
    const result = results[fetchIndex++]
    return result instanceof Promise ? result : Promise.resolve(result)
  })
}

describe('OrcaRuntimeService.fetchRemoteWithCache', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('evicts the in-flight Map entry on rejection so the next caller re-fetches', async () => {
    // First call rejects, second call resolves. Without §3.3 Lifecycle
    // `.finally()` eviction, the second caller would await the rejected
    // promise forever (or throw the same error) — the regression pattern
    // described in §3.3.
    mockFetchResults([Promise.reject(new Error('network down')), { stdout: '', stderr: '' }])

    const runtime = new OrcaRuntimeService(null)

    await runtime.fetchRemoteWithCache('/repo/a', 'origin')
    await runtime.fetchRemoteWithCache('/repo/a', 'origin')

    expect(fetchCallCount()).toBe(2)
  })

  it('does not advance the freshness timestamp when the fetch rejects', async () => {
    // A rejected fetch that wrote the timestamp would make the 30s freshness
    // cache "lie" — the next caller would skip the fetch on a repo whose
    // last real sync is unknown. §3.3 mandates success-only writes.
    mockFetchResults([Promise.reject(new Error('boom')), { stdout: '', stderr: '' }])

    const runtime = new OrcaRuntimeService(null)

    await runtime.fetchRemoteWithCache('/repo/b', 'origin')
    // Immediately call again — if the freshness window were armed we would
    // short-circuit and skip the fetch. It must still dispatch a real fetch.
    await runtime.fetchRemoteWithCache('/repo/b', 'origin')

    expect(fetchCallCount()).toBe(2)
  })

  it('serializes two concurrent callers onto a single git fetch', async () => {
    // Two callers hitting the same repo+remote at the same time must share
    // one underlying fetch. Without the in-flight Map they would each
    // dispatch an independent `git fetch`, tripling the network load in the
    // worst case (renderer create + dispatch probe + CLI create).
    let resolveFetch!: () => void
    const pending = new Promise<{ stdout: string; stderr: string }>((resolve) => {
      resolveFetch = () => resolve({ stdout: '', stderr: '' })
    })
    mockFetchResults([pending])

    const runtime = new OrcaRuntimeService(null)

    const first = runtime.fetchRemoteWithCache('/repo/c', 'origin')
    const second = runtime.fetchRemoteWithCache('/repo/c', 'origin')

    // Allow both callers to register before we resolve.
    await Promise.resolve()
    await Promise.resolve()
    expect(fetchCallCount()).toBe(1)

    resolveFetch()
    await Promise.all([first, second])

    expect(fetchCallCount()).toBe(1)
  })

  it('skips the fetch inside the 30s freshness window after a successful fetch', async () => {
    mockFetchResults([{ stdout: '', stderr: '' }])

    const runtime = new OrcaRuntimeService(null)

    await runtime.fetchRemoteWithCache('/repo/d', 'origin')
    await runtime.fetchRemoteWithCache('/repo/d', 'origin')

    // Second call must short-circuit on the freshness window (no new exec).
    expect(fetchCallCount()).toBe(1)
  })

  it('bounds process-lifetime fetch cache maps for churned repo paths', async () => {
    mockFetchResults(Array.from({ length: 520 }, () => ({ stdout: '', stderr: '' })))
    const runtime = new OrcaRuntimeService(null)
    const caches = runtime as unknown as {
      canonicalFetchKeyCache: Map<string, string>
      fetchLastCompletedAt: Map<string, number>
    }

    for (let i = 0; i < 520; i += 1) {
      await runtime.fetchRemoteWithCache(`/repo/cache-${i}`, 'origin')
    }

    expect(caches.canonicalFetchKeyCache.size).toBeLessThanOrEqual(512)
    expect(caches.fetchLastCompletedAt.size).toBeLessThanOrEqual(512)
    expect(caches.canonicalFetchKeyCache.has('/repo/cache-0::origin')).toBe(false)
    expect(caches.fetchLastCompletedAt.has('/repo/cache-0::origin')).toBe(false)
  })

  it('resolves remote-tracking bases with longest configured remote matching', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'foo\nfoo/bar\norigin\n', stderr: '' })
    const runtime = new OrcaRuntimeService(null)

    await expect(runtime.resolveRemoteTrackingBase('/repo/e', 'foo/bar/main')).resolves.toEqual({
      remote: 'foo/bar',
      branch: 'main',
      ref: 'refs/remotes/foo/bar/main',
      base: 'foo/bar/main'
    })
  })

  it('resolves full remote-tracking refs with longest configured remote matching', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'foo\nfoo/bar\norigin\n', stderr: '' })
    const runtime = new OrcaRuntimeService(null)

    await expect(
      runtime.resolveRemoteTrackingBase('/repo/e', 'refs/remotes/foo/bar/main')
    ).resolves.toEqual({
      remote: 'foo/bar',
      branch: 'main',
      ref: 'refs/remotes/foo/bar/main',
      base: 'foo/bar/main'
    })
  })

  it('refreshes a remote-tracking base with an exact no-tags refspec', async () => {
    mockFetchResults([{ stdout: '', stderr: '' }])
    const runtime = new OrcaRuntimeService(null)

    await runtime.getOrStartRemoteTrackingBaseRefresh('/repo/f', {
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
      exactBaseRefreshOptions('/repo/f')
    )
  })

  it('shares an in-flight remote-tracking base refresh and reuses exact-base freshness', async () => {
    let resolveFetch!: () => void
    const pending = new Promise<{ stdout: string; stderr: string }>((resolve) => {
      resolveFetch = () => resolve({ stdout: '', stderr: '' })
    })
    mockFetchResults([pending, { stdout: '', stderr: '' }])
    const runtime = new OrcaRuntimeService(null)
    const base = {
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    }

    const first = runtime.getOrStartRemoteTrackingBaseRefresh('/repo/g', base)
    const second = runtime.getOrStartRemoteTrackingBaseRefresh('/repo/g', base)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchCallCount()).toBe(1)

    resolveFetch()
    await Promise.all([first, second])
    await runtime.getOrStartRemoteTrackingBaseRefresh('/repo/g', base)

    expect(fetchCallCount()).toBe(1)
  })

  it('does not advance exact-base freshness when a remote-tracking refresh fails', async () => {
    mockFetchResults([Promise.reject(new Error('network down')), { stdout: '', stderr: '' }])
    const runtime = new OrcaRuntimeService(null)
    const base = {
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    }

    await expect(
      runtime.getOrStartRemoteTrackingBaseRefresh('/repo/g-fail', base)
    ).resolves.toEqual({
      ok: false,
      errorKind: 'git_error'
    })
    await expect(
      runtime.getOrStartRemoteTrackingBaseRefresh('/repo/g-fail', base)
    ).resolves.toEqual({ ok: true })

    expect(fetchCallCount()).toBe(2)
  })

  it('does not treat a recent full remote fetch as exact-base freshness', async () => {
    mockFetchResults([
      { stdout: '', stderr: '' },
      { stdout: '', stderr: '' }
    ])
    const runtime = new OrcaRuntimeService(null)
    const base = {
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    }

    await runtime.getOrStartRemoteFetch('/repo/g-full', 'origin')
    await expect(
      runtime.getOrStartRemoteTrackingBaseRefresh('/repo/g-full', base)
    ).resolves.toEqual({ ok: true })

    expect(fetchCallCount()).toBe(2)
  })

  it('queues a full remote fetch behind an in-flight remote-tracking base refresh', async () => {
    let resolveBaseFetch!: () => void
    let resolveFullFetch!: () => void
    const pendingBaseFetch = new Promise<{ stdout: string; stderr: string }>((resolve) => {
      resolveBaseFetch = () => resolve({ stdout: '', stderr: '' })
    })
    const pendingFullFetch = new Promise<{ stdout: string; stderr: string }>((resolve) => {
      resolveFullFetch = () => resolve({ stdout: '', stderr: '' })
    })
    mockFetchResults([pendingBaseFetch, pendingFullFetch])
    const runtime = new OrcaRuntimeService(null)
    const base = {
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    }

    const baseRefresh = runtime.getOrStartRemoteTrackingBaseRefresh('/repo/h', base)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchCallCount()).toBe(1)

    const fullFetch = runtime.getOrStartRemoteFetch('/repo/h', 'origin')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchCallCount()).toBe(1)

    resolveBaseFetch()
    await vi.waitFor(() => expect(fetchCallCount()).toBe(2))
    resolveFullFetch()

    await expect(Promise.all([baseRefresh, fullFetch])).resolves.toEqual([
      { ok: true },
      { ok: true }
    ])
    const fetchCalls = gitExecFileAsyncMock.mock.calls.filter(
      ([argv]) => Array.isArray(argv) && argv[0] === 'fetch'
    )
    expect(fetchCalls).toEqual([
      [
        ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
        exactBaseRefreshOptions('/repo/h')
      ],
      [['fetch', 'origin'], fullRemoteFetchOptions('/repo/h')]
    ])
  })

  it('runs a queued exact base refresh after an in-flight full remote fetch succeeds', async () => {
    let resolveFullFetch!: () => void
    let resolveBaseFetch!: () => void
    const pendingFullFetch = new Promise<{ stdout: string; stderr: string }>((resolve) => {
      resolveFullFetch = () => resolve({ stdout: '', stderr: '' })
    })
    const pendingBaseFetch = new Promise<{ stdout: string; stderr: string }>((resolve) => {
      resolveBaseFetch = () => resolve({ stdout: '', stderr: '' })
    })
    mockFetchResults([pendingFullFetch, pendingBaseFetch])
    const runtime = new OrcaRuntimeService(null)
    const base = {
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    }

    const fullFetch = runtime.getOrStartRemoteFetch('/repo/i', 'origin')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchCallCount()).toBe(1)

    const baseRefresh = runtime.getOrStartRemoteTrackingBaseRefresh('/repo/i', base)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchCallCount()).toBe(1)

    resolveFullFetch()
    await vi.waitFor(() => expect(fetchCallCount()).toBe(2))
    resolveBaseFetch()

    await expect(Promise.all([fullFetch, baseRefresh])).resolves.toEqual([
      { ok: true },
      { ok: true }
    ])
    const fetchCalls = gitExecFileAsyncMock.mock.calls.filter(
      ([argv]) => Array.isArray(argv) && argv[0] === 'fetch'
    )
    expect(fetchCalls).toEqual([
      [['fetch', 'origin'], fullRemoteFetchOptions('/repo/i')],
      [
        ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
        exactBaseRefreshOptions('/repo/i')
      ]
    ])
  })

  it('runs a queued exact base refresh when an in-flight full remote fetch fails', async () => {
    let rejectFullFetch!: () => void
    let resolveBaseFetch!: () => void
    const pendingFullFetch = new Promise<{ stdout: string; stderr: string }>((_resolve, reject) => {
      rejectFullFetch = () => reject(new Error('network unavailable'))
    })
    const pendingBaseFetch = new Promise<{ stdout: string; stderr: string }>((resolve) => {
      resolveBaseFetch = () => resolve({ stdout: '', stderr: '' })
    })
    mockFetchResults([pendingFullFetch, pendingBaseFetch])
    const runtime = new OrcaRuntimeService(null)
    const base = {
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    }

    const fullFetch = runtime.getOrStartRemoteFetch('/repo/i-fail', 'origin')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchCallCount()).toBe(1)

    const baseRefresh = runtime.getOrStartRemoteTrackingBaseRefresh('/repo/i-fail', base)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchCallCount()).toBe(1)

    rejectFullFetch()
    await vi.waitFor(() => expect(fetchCallCount()).toBe(2))
    resolveBaseFetch()

    await expect(Promise.all([fullFetch, baseRefresh])).resolves.toEqual([
      { ok: false, errorKind: 'git_error' },
      { ok: true }
    ])
    const fetchCalls = gitExecFileAsyncMock.mock.calls.filter(
      ([argv]) => Array.isArray(argv) && argv[0] === 'fetch'
    )
    expect(fetchCalls).toEqual([
      [['fetch', 'origin'], fullRemoteFetchOptions('/repo/i-fail')],
      [
        ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
        exactBaseRefreshOptions('/repo/i-fail')
      ]
    ])
  })
})
