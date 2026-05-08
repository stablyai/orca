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
})
