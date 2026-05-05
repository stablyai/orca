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
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    const runtime = new OrcaRuntimeService(null)

    await runtime.fetchRemoteWithCache('/repo/a', 'origin')
    await runtime.fetchRemoteWithCache('/repo/a', 'origin')

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('does not advance the freshness timestamp when the fetch rejects', async () => {
    // A rejected fetch that wrote the timestamp would make the 30s freshness
    // cache "lie" — the next caller would skip the fetch on a repo whose
    // last real sync is unknown. §3.3 mandates success-only writes.
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    const runtime = new OrcaRuntimeService(null)

    await runtime.fetchRemoteWithCache('/repo/b', 'origin')
    // Immediately call again — if the freshness window were armed we would
    // short-circuit and skip the fetch. It must still dispatch a real fetch.
    await runtime.fetchRemoteWithCache('/repo/b', 'origin')

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
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
    gitExecFileAsyncMock.mockReturnValueOnce(pending)

    const runtime = new OrcaRuntimeService(null)

    const first = runtime.fetchRemoteWithCache('/repo/c', 'origin')
    const second = runtime.fetchRemoteWithCache('/repo/c', 'origin')

    // Allow both callers to register before we resolve.
    await Promise.resolve()
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)

    resolveFetch()
    await Promise.all([first, second])

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('skips the fetch inside the 30s freshness window after a successful fetch', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    const runtime = new OrcaRuntimeService(null)

    await runtime.fetchRemoteWithCache('/repo/d', 'origin')
    await runtime.fetchRemoteWithCache('/repo/d', 'origin')

    // Second call must short-circuit on the freshness window (no new exec).
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })
})
