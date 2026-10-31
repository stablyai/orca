import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('./runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))

import { PROBE_COALESCE_STALE_MS } from './coalesced-probe'
import { createRemoteRefProbeCache, NEGATIVE_ENTRY_TTL_MS } from './remote-ref-probe-cache'

/** Stands in for a forge's parser: claims one host, rejects everything else. */
function parseExampleRef(remoteUrl: string): { repo: string } | null {
  const match = remoteUrl.trim().match(/^git@example\.com:(.+?)(?:\.git)?$/)
  return match ? { repo: match[1] } : null
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('remote ref probe cache (P1-D)', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-probes a repo whose remotes could have changed since the miss', async () => {
    const cache = createRemoteRefProbeCache(parseExampleRef)
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error("fatal: No such remote 'origin'"))

    await expect(cache.get('/repo', 'origin')).resolves.toBeNull()
    await expect(cache.get('/repo', 'origin')).resolves.toBeNull()
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)

    // Expiring negatives reveal new remotes without filesystem watchers on SSH/WSL.
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'git@example.com:team/repo.git\n' })
    vi.setSystemTime(1_000_000 + NEGATIVE_ENTRY_TTL_MS + 1)

    await expect(cache.get('/repo', 'origin')).resolves.toEqual({ repo: 'team/repo' })
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('does not let a probe abandoned as stale overwrite its successor answer', async () => {
    const cache = createRemoteRefProbeCache(parseExampleRef)
    const stalled = deferred<{ stdout: string }>()
    gitExecFileAsyncMock
      .mockImplementationOnce(async () => await stalled.promise)
      .mockResolvedValue({ stdout: 'git@example.com:team/repo.git\n' })

    const abandoned = cache.get('/repo', 'origin')
    vi.setSystemTime(1_000_000 + PROBE_COALESCE_STALE_MS + 1)
    await expect(cache.get('/repo', 'origin')).resolves.toEqual({ repo: 'team/repo' })

    // Abandoned probes still answer their caller but must not overwrite newer cached state.
    stalled.resolve({ stdout: 'git@elsewhere.example:team/repo.git\n' })
    await expect(abandoned).resolves.toBeNull()

    await expect(cache.get('/repo', 'origin')).resolves.toEqual({ repo: 'team/repo' })
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('answers an SSH repo with null without running git on this machine', async () => {
    const cache = createRemoteRefProbeCache(parseExampleRef)

    await expect(cache.get('/repo', 'origin', 'conn-1')).resolves.toBeNull()
    await expect(cache.get('/repo', 'origin', 'conn-1')).resolves.toBeNull()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('does not cache a probe killed on its deadline as a definitive miss', async () => {
    const cache = createRemoteRefProbeCache(parseExampleRef)
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('git timed out.'))
      .mockResolvedValueOnce({ stdout: 'git@example.com:team/repo.git\n' })

    await expect(cache.get('/repo', 'origin')).resolves.toBeNull()
    await expect(cache.get('/repo', 'origin')).resolves.toEqual({ repo: 'team/repo' })
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })
})
