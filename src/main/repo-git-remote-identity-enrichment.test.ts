import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitRemoteIdentity } from '../shared/git-remote-identity'
import type { Repo } from '../shared/types'
import { detectGitRemoteIdentity } from './repo-git-remote-identity'
import {
  MAX_REPO_REMOTE_IDENTITY_NEGATIVE_CACHE_LOCATIONS,
  enrichMissingRepoGitRemoteIdentities,
  flushRepoGitRemoteIdentityEnrichmentForTests,
  getRepoGitRemoteIdentityBackgroundTaskCountForTests,
  getRepoGitRemoteIdentityEnrichmentCountsForTests,
  hasRepoGitRemoteIdentityNegativeCacheForTests,
  resetRepoGitRemoteIdentityEnrichmentForTests
} from './repo-git-remote-identity-enrichment'

vi.mock('./repo-git-remote-identity', () => ({
  detectGitRemoteIdentity: vi.fn()
}))

type RepoIdentityStore = {
  getRepos: () => Repo[]
  getRepo: (id: string) => Repo | undefined
  updateRepo: (
    id: string,
    updates: Pick<Partial<Repo>, 'gitRemoteIdentity'>,
    expectedLifecycle?: Repo
  ) => Repo | null
}

const remoteIdentity: GitRemoteIdentity = {
  canonicalKey: 'git.company.test/team/sample-app',
  remoteName: 'origin',
  remoteUrl: 'git@git.company.test:team/sample-app.git'
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/workspace/sample-app',
    displayName: 'sample-app',
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

function makeStoreForRepos(
  repos: Repo[]
): RepoIdentityStore & { updateRepo: ReturnType<typeof vi.fn> } {
  return {
    getRepos: () => repos,
    getRepo: (id) => repos.find((candidate) => candidate.id === id),
    updateRepo: vi.fn(
      (id: string, updates: Pick<Partial<Repo>, 'gitRemoteIdentity'>, expectedLifecycle?: Repo) => {
        const target = repos.find(
          (candidate) =>
            candidate.id === id &&
            (!expectedLifecycle ||
              (candidate.path === expectedLifecycle.path &&
                candidate.addedAt === expectedLifecycle.addedAt &&
                (candidate.connectionId ?? null) === (expectedLifecycle.connectionId ?? null) &&
                (candidate.executionHostId ?? null) ===
                  (expectedLifecycle.executionHostId ?? null)))
        )
        if (!target) {
          return null
        }
        Object.assign(target, updates)
        return target
      }
    )
  }
}

function makeStore(repo: Repo): RepoIdentityStore & { updateRepo: ReturnType<typeof vi.fn> } {
  return makeStoreForRepos([repo])
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  resetRepoGitRemoteIdentityEnrichmentForTests()
})

describe('enrichMissingRepoGitRemoteIdentities', () => {
  it('schedules remote identity enrichment without blocking the caller', async () => {
    vi.mocked(detectGitRemoteIdentity).mockResolvedValue(remoteIdentity)
    const repo = makeRepo()
    const store = makeStore(repo)
    const onChanged = vi.fn()

    enrichMissingRepoGitRemoteIdentities(store, { onChanged })

    expect(repo.gitRemoteIdentity).toBeUndefined()
    expect(detectGitRemoteIdentity).toHaveBeenCalledWith('/workspace/sample-app', undefined)

    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(repo.gitRemoteIdentity).toEqual(remoteIdentity)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('flushes the whole sequential pass, including probes that start later', async () => {
    const firstProbe = deferred<GitRemoteIdentity | null>()
    const secondProbe = deferred<GitRemoteIdentity | null>()
    vi.mocked(detectGitRemoteIdentity)
      .mockReturnValueOnce(firstProbe.promise)
      .mockReturnValueOnce(secondProbe.promise)
    const store = makeStoreForRepos([
      makeRepo({ id: 'first', path: '/workspace/first' }),
      makeRepo({ id: 'second', path: '/workspace/second' })
    ])

    enrichMissingRepoGitRemoteIdentities(store)
    let flushed = false
    const flush = flushRepoGitRemoteIdentityEnrichmentForTests().then(() => {
      flushed = true
    })
    firstProbe.resolve(null)
    await vi.waitFor(() => expect(detectGitRemoteIdentity).toHaveBeenCalledTimes(2))

    expect(flushed).toBe(false)
    secondProbe.resolve(null)
    await flush

    expect(flushed).toBe(true)
  })

  it('coalesces concurrent probes for the same repo location', async () => {
    const probe = deferred<GitRemoteIdentity | null>()
    vi.mocked(detectGitRemoteIdentity).mockReturnValue(probe.promise)
    const repo = makeRepo()
    const store = makeStore(repo)

    enrichMissingRepoGitRemoteIdentities(store)
    enrichMissingRepoGitRemoteIdentities(store)

    expect(detectGitRemoteIdentity).toHaveBeenCalledTimes(1)

    probe.resolve(remoteIdentity)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(store.updateRepo).toHaveBeenCalledTimes(1)
    expect(repo.gitRemoteIdentity).toEqual(remoteIdentity)
  })

  it('bounds repeated list requests to one active pass and one newest rerun', async () => {
    const probe = deferred<GitRemoteIdentity | null>()
    vi.mocked(detectGitRemoteIdentity).mockReturnValue(probe.promise)
    const repo = makeRepo()
    const store = makeStore(repo)
    const onChanged = vi.fn()

    enrichMissingRepoGitRemoteIdentities(store, { onChanged })
    for (let index = 0; index < 100; index++) {
      enrichMissingRepoGitRemoteIdentities(store, { onChanged })
    }

    expect(detectGitRemoteIdentity).toHaveBeenCalledTimes(1)
    expect(getRepoGitRemoteIdentityBackgroundTaskCountForTests()).toBe(1)
    probe.resolve(remoteIdentity)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(detectGitRemoteIdentity).toHaveBeenCalledTimes(1)
    expect(getRepoGitRemoteIdentityBackgroundTaskCountForTests()).toBe(0)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('skips runtime-host paths that this process cannot probe', async () => {
    const store = makeStore(
      makeRepo({ executionHostId: 'runtime:environment-1', path: '/runtime/workspace/repo' })
    )

    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(detectGitRemoteIdentity).not.toHaveBeenCalled()
    expect(store.updateRepo).not.toHaveBeenCalled()
  })

  it('probes a runtime-stamped path when the owning runtime grants authority', async () => {
    vi.mocked(detectGitRemoteIdentity).mockResolvedValue(remoteIdentity)
    const repo = makeRepo({
      executionHostId: 'runtime:environment-1',
      path: '/runtime/workspace/repo'
    })
    const store = makeStore(repo)

    enrichMissingRepoGitRemoteIdentities(store, { probeRuntimeHostPaths: true })
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(detectGitRemoteIdentity).toHaveBeenCalledWith('/runtime/workspace/repo', undefined)
    expect(repo.gitRemoteIdentity).toEqual(remoteIdentity)
  })

  it('keeps SSH identity probes on the SSH provider path', async () => {
    vi.mocked(detectGitRemoteIdentity).mockResolvedValue(remoteIdentity)
    const repo = makeRepo({
      connectionId: 'ssh-target',
      executionHostId: 'runtime:environment-1',
      path: '/remote/workspace/repo'
    })
    const store = makeStore(repo)

    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(detectGitRemoteIdentity).toHaveBeenCalledWith('/remote/workspace/repo', 'ssh-target')
    expect(repo.gitRemoteIdentity).toEqual(remoteIdentity)
  })

  it('enriches duplicate repo IDs independently across execution hosts', async () => {
    vi.mocked(detectGitRemoteIdentity).mockImplementation(async (_path, connectionId) => ({
      ...remoteIdentity,
      canonicalKey: `git.company.test/${connectionId ?? 'local'}`
    }))
    const localRepo = makeRepo({ id: 'shared', path: '/same/path' })
    const sshRepo = makeRepo({
      id: 'shared',
      path: '/same/path',
      connectionId: 'ssh-target',
      executionHostId: 'ssh:ssh-target'
    })
    const store = makeStoreForRepos([localRepo, sshRepo])

    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(localRepo.gitRemoteIdentity?.canonicalKey).toBe('git.company.test/local')
    expect(sshRepo.gitRemoteIdentity?.canonicalKey).toBe('git.company.test/ssh-target')
    expect(store.updateRepo).toHaveBeenCalledTimes(2)
  })

  it('does not let reset-era local work mutate a runtime-host replacement', async () => {
    const staleProbe = deferred<GitRemoteIdentity | null>()
    vi.mocked(detectGitRemoteIdentity).mockReturnValue(staleProbe.promise)
    const repos = [makeRepo()]
    const store = makeStoreForRepos(repos)

    enrichMissingRepoGitRemoteIdentities(store)
    resetRepoGitRemoteIdentityEnrichmentForTests()
    const replacement = makeRepo({ addedAt: 2, executionHostId: 'runtime:environment-1' })
    repos.splice(0, repos.length, replacement)
    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()
    staleProbe.resolve(remoteIdentity)
    await Promise.resolve()
    await Promise.resolve()

    expect(detectGitRemoteIdentity).toHaveBeenCalledTimes(1)
    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(replacement.gitRemoteIdentity).toBeUndefined()
    expect(hasRepoGitRemoteIdentityNegativeCacheForTests(replacement)).toBe(false)
  })

  it('caches no-identity probes briefly so list calls do not retry every time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.mocked(detectGitRemoteIdentity).mockResolvedValue(null)
    const repo = makeRepo()
    const store = makeStore(repo)

    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()
    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(detectGitRemoteIdentity).toHaveBeenCalledTimes(1)
  })

  it('keeps runtime-host retry TTLs across desktop passes without granting probe authority', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.mocked(detectGitRemoteIdentity).mockResolvedValue(null)
    const repo = makeRepo({
      executionHostId: 'runtime:environment-1',
      path: '/runtime/workspace/repo'
    })
    const repos = [repo]
    const store = makeStoreForRepos(repos)

    enrichMissingRepoGitRemoteIdentities(store, { probeRuntimeHostPaths: true })
    await flushRepoGitRemoteIdentityEnrichmentForTests()
    expect(detectGitRemoteIdentity).toHaveBeenCalledTimes(1)
    expect(hasRepoGitRemoteIdentityNegativeCacheForTests(repo)).toBe(true)

    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()
    enrichMissingRepoGitRemoteIdentities(store, { probeRuntimeHostPaths: true })
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(detectGitRemoteIdentity).toHaveBeenCalledTimes(1)
    expect(hasRepoGitRemoteIdentityNegativeCacheForTests(repo)).toBe(true)

    repos.splice(0, repos.length)
    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()
    expect(hasRepoGitRemoteIdentityNegativeCacheForTests(repo)).toBe(false)
  })

  it('releases timed-out probe state and retries after the negative-cache TTL', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.mocked(detectGitRemoteIdentity)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(remoteIdentity)
    const repo = makeRepo()
    const store = makeStore(repo)

    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(getRepoGitRemoteIdentityEnrichmentCountsForTests()).toEqual({
      inFlight: 0,
      negativeCache: 1
    })
    expect(getRepoGitRemoteIdentityBackgroundTaskCountForTests()).toBe(0)

    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(detectGitRemoteIdentity).toHaveBeenCalledTimes(2)
    expect(repo.gitRemoteIdentity).toEqual(remoteIdentity)
    expect(getRepoGitRemoteIdentityBackgroundTaskCountForTests()).toBe(0)
  })

  it('prunes no-identity retry entries for removed repo locations', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.mocked(detectGitRemoteIdentity).mockResolvedValue(null)
    const oldRepo = makeRepo({ id: 'old', path: '/workspace/old' })
    const newRepo = makeRepo({ id: 'new', path: '/workspace/new' })
    const repos = [oldRepo]
    const store = makeStoreForRepos(repos)

    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(getRepoGitRemoteIdentityEnrichmentCountsForTests()).toEqual({
      inFlight: 0,
      negativeCache: 1
    })
    expect(hasRepoGitRemoteIdentityNegativeCacheForTests(oldRepo)).toBe(true)

    repos.splice(0, repos.length, newRepo)
    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(getRepoGitRemoteIdentityEnrichmentCountsForTests()).toEqual({
      inFlight: 0,
      negativeCache: 1
    })
    expect(hasRepoGitRemoteIdentityNegativeCacheForTests(oldRepo)).toBe(false)
    expect(hasRepoGitRemoteIdentityNegativeCacheForTests(newRepo)).toBe(true)
  })

  it('caps no-identity retry entries while retaining recently refreshed locations', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.mocked(detectGitRemoteIdentity).mockResolvedValue(null)
    const repos = Array.from(
      { length: MAX_REPO_REMOTE_IDENTITY_NEGATIVE_CACHE_LOCATIONS - 1 },
      (_, index) => makeRepo({ id: `repo-${index}`, path: `/workspace/repo-${index}` })
    )
    const keepRepo = makeRepo({ id: 'keep', path: '/workspace/keep' })
    repos.push(keepRepo)
    const store = makeStoreForRepos(repos)

    enrichMissingRepoGitRemoteIdentities(store)
    await vi.waitFor(() =>
      expect(detectGitRemoteIdentity).toHaveBeenCalledTimes(
        MAX_REPO_REMOTE_IDENTITY_NEGATIVE_CACHE_LOCATIONS
      )
    )
    repos.push(makeRepo({ id: 'new', path: '/workspace/new' }))
    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(detectGitRemoteIdentity).toHaveBeenCalledTimes(
      MAX_REPO_REMOTE_IDENTITY_NEGATIVE_CACHE_LOCATIONS + 1
    )
    expect(hasRepoGitRemoteIdentityNegativeCacheForTests(repos[0]!)).toBe(false)

    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(getRepoGitRemoteIdentityEnrichmentCountsForTests()).toEqual({
      inFlight: 0,
      negativeCache: MAX_REPO_REMOTE_IDENTITY_NEGATIVE_CACHE_LOCATIONS
    })
    // One overflowed lifecycle is retried per pass; eviction must not cascade
    // into a 513-process storm during the same repos:list call.
    expect(detectGitRemoteIdentity).toHaveBeenCalledTimes(
      MAX_REPO_REMOTE_IDENTITY_NEGATIVE_CACHE_LOCATIONS + 2
    )
    expect(hasRepoGitRemoteIdentityNegativeCacheForTests(repos[0]!)).toBe(true)
    expect(hasRepoGitRemoteIdentityNegativeCacheForTests(repos[1]!)).toBe(false)
    expect(hasRepoGitRemoteIdentityNegativeCacheForTests(keepRepo)).toBe(true)
    expect(hasRepoGitRemoteIdentityNegativeCacheForTests(repos.at(-1)!)).toBe(true)
  })

  it('does not let a late null result suppress a replacement repo lifecycle', async () => {
    const oldProbe = deferred<GitRemoteIdentity | null>()
    vi.mocked(detectGitRemoteIdentity)
      .mockReturnValueOnce(oldProbe.promise)
      .mockResolvedValueOnce(remoteIdentity)
    const oldRepo = makeRepo()
    const repos = [oldRepo]
    const store = makeStoreForRepos(repos)

    enrichMissingRepoGitRemoteIdentities(store)
    const replacement = makeRepo({ addedAt: 2 })
    repos.splice(0, repos.length, replacement)
    oldProbe.resolve(null)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(hasRepoGitRemoteIdentityNegativeCacheForTests(replacement)).toBe(false)
    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(detectGitRemoteIdentity).toHaveBeenCalledTimes(2)
    expect(replacement.gitRemoteIdentity).toEqual(remoteIdentity)
  })

  it('uses addedAt with the repo UUID to reject same-ID and same-path reuse', async () => {
    const probe = deferred<GitRemoteIdentity | null>()
    vi.mocked(detectGitRemoteIdentity).mockReturnValue(probe.promise)
    const oldRepo = makeRepo()
    const repos = [oldRepo]
    const store = makeStoreForRepos(repos)

    enrichMissingRepoGitRemoteIdentities(store)
    const replacement = makeRepo({ addedAt: 2 })
    repos.splice(0, repos.length, replacement)
    probe.resolve(remoteIdentity)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(replacement.gitRemoteIdentity).toBeUndefined()
  })

  it('isolates reset generations from pending probes', async () => {
    const staleProbe = deferred<GitRemoteIdentity | null>()
    vi.mocked(detectGitRemoteIdentity)
      .mockReturnValueOnce(staleProbe.promise)
      .mockResolvedValueOnce(remoteIdentity)
    const repo = makeRepo()
    const store = makeStore(repo)

    enrichMissingRepoGitRemoteIdentities(store)
    resetRepoGitRemoteIdentityEnrichmentForTests()
    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(repo.gitRemoteIdentity).toEqual(remoteIdentity)
    staleProbe.resolve(null)
    await vi.waitFor(() =>
      expect(getRepoGitRemoteIdentityEnrichmentCountsForTests().inFlight).toBe(0)
    )

    expect(hasRepoGitRemoteIdentityNegativeCacheForTests(repo)).toBe(false)
    expect(store.updateRepo).toHaveBeenCalledTimes(1)
  })

  it('does not write stale identity data after the repo path changes', async () => {
    const probe = deferred<GitRemoteIdentity | null>()
    vi.mocked(detectGitRemoteIdentity).mockReturnValue(probe.promise)
    const repo = makeRepo()
    const store = makeStore(repo)

    enrichMissingRepoGitRemoteIdentities(store)
    repo.path = '/workspace/renamed-sample-app'
    probe.resolve(remoteIdentity)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(repo.gitRemoteIdentity).toBeUndefined()
  })
})
