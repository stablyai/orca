import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitRemoteIdentity } from '../shared/git-remote-identity'
import type { Repo } from '../shared/types'
import { detectGitRemoteIdentity } from './repo-git-remote-identity'
import {
  enrichMissingRepoGitRemoteIdentities,
  flushRepoGitRemoteIdentityEnrichmentForTests,
  getRepoGitRemoteIdentityBackgroundTaskCountForTests,
  resetRepoGitRemoteIdentityEnrichmentForTests
} from './repo-git-remote-identity-enrichment'

vi.mock('./repo-git-remote-identity', () => ({
  detectGitRemoteIdentity: vi.fn()
}))

const remoteIdentity: GitRemoteIdentity = {
  canonicalKey: 'git.company.test/team/app',
  remoteName: 'origin',
  remoteUrl: 'git@git.company.test:team/app.git'
}

function repo(id: string, executionHostId?: `runtime:${string}`): Repo {
  return {
    id,
    path: `/workspace/${id}`,
    displayName: id,
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git',
    ...(executionHostId ? { executionHostId } : {})
  }
}

function storeFor(repos: Repo[]) {
  return {
    getRepos: () => repos,
    updateRepo: vi.fn((id: string, updates: Partial<Repo>, expected?: Repo) => {
      const target = repos.find(
        (candidate) =>
          candidate.id === id &&
          (!expected ||
            (candidate.path === expected.path &&
              candidate.addedAt === expected.addedAt &&
              (candidate.connectionId ?? null) === (expected.connectionId ?? null) &&
              (candidate.executionHostId ?? null) === (expected.executionHostId ?? null)))
      )
      if (!target) {
        return null
      }
      Object.assign(target, updates)
      return target
    })
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.clearAllMocks()
  resetRepoGitRemoteIdentityEnrichmentForTests()
})

describe('remote identity enrichment consumer coalescing', () => {
  it.each([
    { name: 'desktop then runtime', firstChannel: 'desktop' as const, firstAuthority: false },
    { name: 'runtime then desktop', firstChannel: 'runtime' as const, firstAuthority: true }
  ])('notifies both channels exactly once for $name overlap', async (scenario) => {
    const firstProbe = deferred<GitRemoteIdentity | null>()
    vi.mocked(detectGitRemoteIdentity)
      .mockReturnValueOnce(firstProbe.promise)
      .mockResolvedValue(remoteIdentity)
    const repos = [repo('local'), repo('remote', 'runtime:environment-1')]
    const store = storeFor(repos)
    const desktopChanged = vi.fn()
    const runtimeChanged = vi.fn()
    const callback = scenario.firstChannel === 'desktop' ? desktopChanged : runtimeChanged

    enrichMissingRepoGitRemoteIdentities(store, {
      notificationChannel: scenario.firstChannel,
      probeRuntimeHostPaths: scenario.firstAuthority,
      onChanged: callback
    })
    enrichMissingRepoGitRemoteIdentities(store, {
      notificationChannel: scenario.firstChannel === 'desktop' ? 'runtime' : 'desktop',
      probeRuntimeHostPaths: scenario.firstChannel === 'desktop',
      onChanged: scenario.firstChannel === 'desktop' ? runtimeChanged : desktopChanged
    })
    // A later low-authority request must not replace the pending authority or callback.
    enrichMissingRepoGitRemoteIdentities(store, {
      notificationChannel: 'desktop',
      onChanged: desktopChanged
    })
    firstProbe.resolve(remoteIdentity)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(repos.every((candidate) => candidate.gitRemoteIdentity)).toBe(true)
    expect(detectGitRemoteIdentity).toHaveBeenCalledTimes(2)
    expect(desktopChanged).toHaveBeenCalledTimes(1)
    expect(runtimeChanged).toHaveBeenCalledTimes(1)
  })

  it('does not notify either channel when every pass is unchanged', async () => {
    const firstProbe = deferred<GitRemoteIdentity | null>()
    vi.mocked(detectGitRemoteIdentity).mockReturnValueOnce(firstProbe.promise).mockResolvedValue(null)
    const store = storeFor([repo('local'), repo('remote', 'runtime:environment-1')])
    const desktopChanged = vi.fn()
    const runtimeChanged = vi.fn()

    enrichMissingRepoGitRemoteIdentities(store, {
      notificationChannel: 'desktop',
      onChanged: desktopChanged
    })
    enrichMissingRepoGitRemoteIdentities(store, {
      notificationChannel: 'runtime',
      probeRuntimeHostPaths: true,
      onChanged: runtimeChanged
    })
    firstProbe.resolve(null)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(desktopChanged).not.toHaveBeenCalled()
    expect(runtimeChanged).not.toHaveBeenCalled()
  })

  it('keeps both channels through an errored pass and notifies once after a changed rerun', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(detectGitRemoteIdentity)
      .mockRejectedValueOnce(new Error('probe failed'))
      .mockResolvedValue(remoteIdentity)
    const store = storeFor([repo('local'), repo('remote', 'runtime:environment-1')])
    const desktopChanged = vi.fn()
    const runtimeChanged = vi.fn()

    enrichMissingRepoGitRemoteIdentities(store, {
      notificationChannel: 'desktop',
      onChanged: desktopChanged
    })
    enrichMissingRepoGitRemoteIdentities(store, {
      notificationChannel: 'runtime',
      probeRuntimeHostPaths: true,
      onChanged: runtimeChanged
    })
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(desktopChanged).toHaveBeenCalledTimes(1)
    expect(runtimeChanged).toHaveBeenCalledTimes(1)
  })

  it('drops stale-generation channels on reset instead of leaking them into new work', async () => {
    const staleProbe = deferred<GitRemoteIdentity | null>()
    vi.mocked(detectGitRemoteIdentity)
      .mockReturnValueOnce(staleProbe.promise)
      .mockResolvedValue(remoteIdentity)
    const store = storeFor([repo('local')])
    const staleDesktopChanged = vi.fn()
    const staleRuntimeChanged = vi.fn()
    const currentDesktopChanged = vi.fn()

    enrichMissingRepoGitRemoteIdentities(store, {
      notificationChannel: 'desktop',
      onChanged: staleDesktopChanged
    })
    enrichMissingRepoGitRemoteIdentities(store, {
      notificationChannel: 'runtime',
      onChanged: staleRuntimeChanged
    })
    resetRepoGitRemoteIdentityEnrichmentForTests()
    staleProbe.resolve(remoteIdentity)
    await vi.waitFor(() => expect(getRepoGitRemoteIdentityBackgroundTaskCountForTests()).toBe(0))

    enrichMissingRepoGitRemoteIdentities(store, {
      notificationChannel: 'desktop',
      onChanged: currentDesktopChanged
    })
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(staleDesktopChanged).not.toHaveBeenCalled()
    expect(staleRuntimeChanged).not.toHaveBeenCalled()
    expect(currentDesktopChanged).toHaveBeenCalledTimes(1)
  })
})
