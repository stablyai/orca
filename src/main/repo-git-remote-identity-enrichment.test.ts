import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitRemoteIdentity } from '../shared/git-remote-identity'
import type { Repo } from '../shared/types'
import { type GitRemoteIdentityProbe, probeGitRemoteIdentity } from './repo-git-remote-identity'
import {
  enrichMissingRepoGitRemoteIdentities,
  flushRepoGitRemoteIdentityEnrichmentForTests,
  resetRepoGitRemoteIdentityEnrichmentForTests
} from './repo-git-remote-identity-enrichment'

vi.mock('./repo-git-remote-identity', () => ({
  probeGitRemoteIdentity: vi.fn()
}))

type RepoIdentityStore = {
  getRepos: () => Repo[]
  getRepo: (id: string) => Repo | undefined
  updateRepo: (id: string, updates: Pick<Partial<Repo>, 'gitRemoteIdentity'>) => Repo | null
}

const remoteIdentity: GitRemoteIdentity = {
  canonicalKey: 'git.company.test/team/sample-app',
  remoteName: 'origin',
  remoteUrl: 'git@git.company.test:team/sample-app.git'
}

const resolvedProbe: GitRemoteIdentityProbe = {
  status: 'resolved',
  identity: remoteIdentity,
  remotes: [remoteIdentity]
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

function makeStore(repo: Repo): RepoIdentityStore & { updateRepo: ReturnType<typeof vi.fn> } {
  const repos = [repo]
  return {
    getRepos: () => repos,
    getRepo: (id) => repos.find((candidate) => candidate.id === id),
    updateRepo: vi.fn((id, updates) => {
      const target = repos.find((candidate) => candidate.id === id)
      if (!target) {
        return null
      }
      Object.assign(target, updates)
      return target
    })
  }
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
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue(resolvedProbe)
    const repo = makeRepo()
    const store = makeStore(repo)
    const onChanged = vi.fn()

    enrichMissingRepoGitRemoteIdentities(store, { onChanged })

    expect(repo.gitRemoteIdentity).toBeUndefined()
    expect(probeGitRemoteIdentity).toHaveBeenCalledWith('/workspace/sample-app', undefined)

    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(repo.gitRemoteIdentity).toEqual(remoteIdentity)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent probes for the same repo location', async () => {
    const probe = deferred<GitRemoteIdentityProbe>()
    vi.mocked(probeGitRemoteIdentity).mockReturnValue(probe.promise)
    const repo = makeRepo()
    const store = makeStore(repo)

    enrichMissingRepoGitRemoteIdentities(store)
    enrichMissingRepoGitRemoteIdentities(store)

    expect(probeGitRemoteIdentity).toHaveBeenCalledTimes(1)

    probe.resolve(resolvedProbe)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(store.updateRepo).toHaveBeenCalledTimes(1)
    expect(repo.gitRemoteIdentity).toEqual(remoteIdentity)
  })

  it('caches no-identity probes briefly so list calls do not retry every time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue({ status: 'no-remote' })
    const repo = makeRepo()
    const store = makeStore(repo)

    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()
    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(probeGitRemoteIdentity).toHaveBeenCalledTimes(1)
  })

  it('settles a repo git answered for but that has no usable remote', async () => {
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue({ status: 'no-remote' })
    const repo = makeRepo()
    const store = makeStore(repo)

    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(store.updateRepo).toHaveBeenCalledWith('repo-1', { gitRemoteIdentity: null })
    expect(repo.gitRemoteIdentity).toBeNull()
  })

  it('leaves identity unresolved when the probe could not reach the host', async () => {
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue({ status: 'unavailable' })
    const repo = makeRepo({ connectionId: 'builder' })
    const store = makeStore(repo)

    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(repo.gitRemoteIdentity).toBeUndefined()
  })

  it('does not rewrite the no-remote marker on a later retry', async () => {
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue({ status: 'no-remote' })
    const repo = makeRepo({ gitRemoteIdentity: null })
    const store = makeStore(repo)

    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(store.updateRepo).not.toHaveBeenCalled()
  })

  it('resolves a settled no-remote repo once it gains a remote', async () => {
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue(resolvedProbe)
    const repo = makeRepo({ gitRemoteIdentity: null })
    const store = makeStore(repo)

    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(store.updateRepo).toHaveBeenCalledWith('repo-1', { gitRemoteIdentity: remoteIdentity })
  })

  it('does not write stale identity data after the repo path changes', async () => {
    const probe = deferred<GitRemoteIdentityProbe>()
    vi.mocked(probeGitRemoteIdentity).mockReturnValue(probe.promise)
    const repo = makeRepo()
    const store = makeStore(repo)

    enrichMissingRepoGitRemoteIdentities(store)
    repo.path = '/workspace/renamed-sample-app'
    probe.resolve(resolvedProbe)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(repo.gitRemoteIdentity).toBeUndefined()
  })
})
