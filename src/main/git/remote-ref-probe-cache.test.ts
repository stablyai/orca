import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getSshGitProviderMock, getSshGitProviderGenerationMock, gitExecFileAsyncMock } = vi.hoisted(
  () => ({
    getSshGitProviderMock: vi.fn(),
    getSshGitProviderGenerationMock: vi.fn(() => 0),
    gitExecFileAsyncMock: vi.fn()
  })
)

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  getSshGitProviderGeneration: getSshGitProviderGenerationMock,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'SSH Git provider unavailable'
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
    getSshGitProviderMock.mockReset()
    getSshGitProviderGenerationMock.mockReset()
    getSshGitProviderGenerationMock.mockReturnValue(0)
    gitExecFileAsyncMock.mockReset()
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('answers concurrent lookups for one repo with a single probe', async () => {
    const cache = createRemoteRefProbeCache(parseExampleRef)
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'git@example.com:team/repo.git\n' })

    const answers = await Promise.all([
      cache.get('/repo', 'origin'),
      cache.get('/repo', 'origin'),
      cache.get('/repo', 'origin')
    ])

    expect(answers).toEqual([{ repo: 'team/repo' }, { repo: 'team/repo' }, { repo: 'team/repo' }])
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('re-probes a repo whose remotes could have changed since the miss', async () => {
    const cache = createRemoteRefProbeCache(parseExampleRef)
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error("fatal: No such remote 'origin'"))

    await expect(cache.get('/repo', 'origin')).resolves.toBeNull()
    await expect(cache.get('/repo', 'origin')).resolves.toBeNull()
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)

    // A remote added after the miss is only visible once the negative expires;
    // nothing here watches .git/config, and SSH/WSL repos have no file to watch.
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'git@example.com:team/repo.git\n' })
    vi.setSystemTime(1_000_000 + NEGATIVE_ENTRY_TTL_MS + 1)

    await expect(cache.get('/repo', 'origin')).resolves.toEqual({ repo: 'team/repo' })
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('keeps a resolved ref without re-probing', async () => {
    const cache = createRemoteRefProbeCache(parseExampleRef)
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'git@example.com:team/repo.git\n' })

    await expect(cache.get('/repo', 'origin')).resolves.toEqual({ repo: 'team/repo' })
    vi.setSystemTime(1_000_000 + NEGATIVE_ENTRY_TTL_MS * 10)
    await expect(cache.get('/repo', 'origin')).resolves.toEqual({ repo: 'team/repo' })

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('does not let a lookup on a reconnected provider join the old connection probe', async () => {
    const cache = createRemoteRefProbeCache(parseExampleRef)
    let releaseStalled = (): void => {}
    const execMock = vi
      .fn()
      .mockImplementationOnce(
        async () => await new Promise((resolve) => (releaseStalled = () => resolve({ stdout: '' })))
      )
      .mockResolvedValue({ stdout: 'git@example.com:team/repo.git\n' })
    getSshGitProviderMock.mockReturnValue({ exec: execMock })

    const stalled = cache.get('/repo', 'origin', 'conn-1')
    getSshGitProviderGenerationMock.mockReturnValue(1)

    await expect(cache.get('/repo', 'origin', 'conn-1')).resolves.toEqual({ repo: 'team/repo' })
    expect(execMock).toHaveBeenCalledTimes(2)

    releaseStalled()
    await expect(stalled).resolves.toBeNull()
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

    // The abandoned probe still answers the caller that started it, but the repo
    // state it read is older than the one already cached — it must not publish.
    stalled.resolve({ stdout: 'git@elsewhere.example:team/repo.git\n' })
    await expect(abandoned).resolves.toBeNull()

    await expect(cache.get('/repo', 'origin')).resolves.toEqual({ repo: 'team/repo' })
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('holds a parsed-as-not-mine remote for the negative interval, then re-asks', async () => {
    const cache = createRemoteRefProbeCache(parseExampleRef)
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'git@elsewhere.example:team/repo.git\n' })

    await expect(cache.get('/repo', 'origin')).resolves.toBeNull()
    await expect(cache.get('/repo', 'origin')).resolves.toBeNull()
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)

    vi.setSystemTime(1_000_000 + NEGATIVE_ENTRY_TTL_MS + 1)
    await expect(cache.get('/repo', 'origin')).resolves.toBeNull()
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('never caches a miss from a runtime that could not be asked at all', async () => {
    const cache = createRemoteRefProbeCache(parseExampleRef)
    getSshGitProviderMock.mockReturnValueOnce(undefined)

    await expect(cache.get('/repo', 'origin', 'conn-1')).resolves.toBeNull()

    // The provider was gone, not the remote: reconnecting must not need the TTL.
    getSshGitProviderMock.mockReturnValue({
      exec: vi.fn(async () => ({ stdout: 'git@example.com:team/repo.git\n' }))
    })
    await expect(cache.get('/repo', 'origin', 'conn-1')).resolves.toEqual({ repo: 'team/repo' })
  })

  it('holds an SSH repo that has no such remote instead of re-asking every poll', async () => {
    const cache = createRemoteRefProbeCache(parseExampleRef)
    const exec = vi.fn(async () => {
      throw new Error("fatal: No such remote 'origin'")
    })
    getSshGitProviderMock.mockReturnValue({ exec })

    await expect(cache.get('/repo', 'origin', 'conn-1')).resolves.toBeNull()
    await expect(cache.get('/repo', 'origin', 'conn-1')).resolves.toBeNull()
    expect(exec).toHaveBeenCalledTimes(1)

    vi.setSystemTime(1_000_000 + NEGATIVE_ENTRY_TTL_MS + 1)
    await expect(cache.get('/repo', 'origin', 'conn-1')).resolves.toBeNull()
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('keeps re-asking an SSH repo whose probe died with its transport', async () => {
    const cache = createRemoteRefProbeCache(parseExampleRef)
    const exec = vi
      .fn()
      .mockRejectedValueOnce(new Error('relay request failed: connection closed'))
      .mockResolvedValue({ stdout: 'git@example.com:team/repo.git\n' })
    getSshGitProviderMock.mockReturnValue({ exec })

    await expect(cache.get('/repo', 'origin', 'conn-1')).resolves.toBeNull()
    await expect(cache.get('/repo', 'origin', 'conn-1')).resolves.toEqual({ repo: 'team/repo' })
    expect(exec).toHaveBeenCalledTimes(2)
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
