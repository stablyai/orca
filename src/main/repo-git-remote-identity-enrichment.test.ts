import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitRemoteIdentity } from '../shared/git-remote-identity'
import type { Repo } from '../shared/repo-types'
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

const resolvedProbe: GitRemoteIdentityProbe = { status: 'resolved', identity: remoteIdentity }

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

function makeStore(...repos: Repo[]): RepoIdentityStore & { updateRepo: ReturnType<typeof vi.fn> } {
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

const REFRESH_STARTUP_DELAY_MS = 5 * 60 * 1000
const REFRESH_TTL_MS = 6 * 60 * 60 * 1000

const movedIdentity: GitRemoteIdentity = {
  canonicalKey: 'git.company.test/platform/sample-app',
  remoteName: 'upstream',
  remoteUrl: 'git@git.company.test:platform/sample-app.git'
}

/** Drains the sequential sweep: each flush only awaits the probe in flight at that moment. */
async function drainEnrichmentSweep(): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await flushRepoGitRemoteIdentityEnrichmentForTests()
  }
}

async function sweep(store: RepoIdentityStore): Promise<void> {
  enrichMissingRepoGitRemoteIdentities(store)
  await drainEnrichmentSweep()
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
    expect(probeGitRemoteIdentity).toHaveBeenCalledWith(
      '/workspace/sample-app',
      'local',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )

    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(repo.gitRemoteIdentity).toEqual(remoteIdentity)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('probes an SSH row that carries only executionHostId on its own host', async () => {
    // Why: a row minted with the unified spelling has no `connectionId`, and reading the raw field
    // would run `git remote -v` against a same-named path on this machine (#11163).
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue(resolvedProbe)
    const store = makeStore(makeRepo({ executionHostId: 'ssh:builder' }))

    enrichMissingRepoGitRemoteIdentities(store)

    expect(probeGitRemoteIdentity).toHaveBeenCalledWith(
      '/workspace/sample-app',
      'ssh:builder',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    await flushRepoGitRemoteIdentityEnrichmentForTests()
  })

  it('never hands a runtime row nested SSH target to this client dispatch table', async () => {
    // Why: `connectionId` on a `runtime:` row names a target inside that server's namespace, so
    // dialing it here reaches a same-named box of ours. The row keeps the probe this process has
    // always run for it; what it must never do is dial our same-named target.
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue({ status: 'unavailable' })
    const store = makeStore(
      makeRepo({ connectionId: 'nested-1', executionHostId: 'runtime:env-a' })
    )

    enrichMissingRepoGitRemoteIdentities(store)

    expect(probeGitRemoteIdentity).toHaveBeenCalledWith(
      '/workspace/sample-app',
      'local',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    await flushRepoGitRemoteIdentityEnrichmentForTests()
  })

  it('keeps same-path rows on two different SSH hosts from sharing one backoff', async () => {
    // Why: the location key decides coalescing and backoff. Keyed on the raw field, two rows that
    // carry only `executionHostId` collapse onto one key, so the first host being down suppresses
    // the probe for the second one entirely.
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue({ status: 'unavailable' })
    const store = makeStore(
      makeRepo({ id: 'repo-m4air', executionHostId: 'ssh:m4air' }),
      makeRepo({ id: 'repo-openclaw', executionHostId: 'ssh:openclaw' })
    )

    await sweep(store)

    expect(probeGitRemoteIdentity).toHaveBeenCalledTimes(2)
    expect(vi.mocked(probeGitRemoteIdentity).mock.calls.map((call) => call[1])).toEqual([
      'ssh:m4air',
      'ssh:openclaw'
    ])
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

  it('does not re-probe a resolved identity before the refresh window elapses', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue(resolvedProbe)
    const store = makeStore(makeRepo({ gitRemoteIdentity: remoteIdentity }))

    // Why two sweeps: the first only schedules the re-probe, so a restart cannot fan out at launch.
    await sweep(store)
    expect(probeGitRemoteIdentity).not.toHaveBeenCalled()

    vi.setSystemTime(1_000 + REFRESH_STARTUP_DELAY_MS + 1)
    await sweep(store)
    expect(probeGitRemoteIdentity).toHaveBeenCalledTimes(1)

    vi.setSystemTime(1_000 + REFRESH_STARTUP_DELAY_MS + REFRESH_TTL_MS - 1)
    await sweep(store)
    expect(probeGitRemoteIdentity).toHaveBeenCalledTimes(1)
  })

  it('re-probes a resolved identity after the refresh window elapses', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue(resolvedProbe)
    const store = makeStore(makeRepo({ gitRemoteIdentity: remoteIdentity }))

    await sweep(store)
    vi.setSystemTime(1_000 + REFRESH_STARTUP_DELAY_MS + 1)
    await sweep(store)
    vi.setSystemTime(1_000 + REFRESH_STARTUP_DELAY_MS + REFRESH_TTL_MS + 2)
    await sweep(store)

    expect(probeGitRemoteIdentity).toHaveBeenCalledTimes(2)
  })

  it('overwrites a resolved identity when the re-probe finds a different canonical key', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue({
      status: 'resolved',
      identity: movedIdentity
    })
    const repo = makeRepo({ gitRemoteIdentity: remoteIdentity })
    const store = makeStore(repo)
    const onChanged = vi.fn()

    await sweep(store)
    vi.setSystemTime(1_000 + REFRESH_STARTUP_DELAY_MS + 1)
    enrichMissingRepoGitRemoteIdentities(store, { onChanged })
    await drainEnrichmentSweep()

    expect(store.updateRepo).toHaveBeenCalledWith('repo-1', { gitRemoteIdentity: movedIdentity })
    expect(repo.gitRemoteIdentity).toEqual(movedIdentity)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('writes nothing when the re-probe returns the same canonical key', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue({
      status: 'resolved',
      identity: { ...remoteIdentity, remoteUrl: 'https://git.company.test/team/sample-app.git' }
    })
    const store = makeStore(makeRepo({ gitRemoteIdentity: remoteIdentity }))
    const onChanged = vi.fn()

    await sweep(store)
    vi.setSystemTime(1_000 + REFRESH_STARTUP_DELAY_MS + 1)
    enrichMissingRepoGitRemoteIdentities(store, { onChanged })
    await drainEnrichmentSweep()

    expect(probeGitRemoteIdentity).toHaveBeenCalledTimes(1)
    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('keeps the existing identity when a re-probe cannot reach the host', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue({ status: 'unavailable' })
    const repo = makeRepo({ connectionId: 'builder', gitRemoteIdentity: remoteIdentity })
    const store = makeStore(repo)

    await sweep(store)
    vi.setSystemTime(1_000 + REFRESH_STARTUP_DELAY_MS + 1)
    await sweep(store)

    expect(probeGitRemoteIdentity).toHaveBeenCalledTimes(1)
    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(repo.gitRemoteIdentity).toEqual(remoteIdentity)
  })

  it('keeps the existing identity when a re-probe reports no usable remote', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue({ status: 'no-remote' })
    const repo = makeRepo({ gitRemoteIdentity: remoteIdentity })
    const store = makeStore(repo)

    await sweep(store)
    vi.setSystemTime(1_000 + REFRESH_STARTUP_DELAY_MS + 1)
    await sweep(store)

    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(repo.gitRemoteIdentity).toEqual(remoteIdentity)
  })

  it('bounds re-probes per sweep so a large repo list drains gradually', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue(resolvedProbe)
    const repos = Array.from({ length: 6 }, (_unused, index) =>
      makeRepo({
        id: `repo-${index}`,
        path: `/workspace/sample-app-${index}`,
        gitRemoteIdentity: remoteIdentity
      })
    )
    const store = makeStore(...repos)

    await sweep(store)
    vi.setSystemTime(1_000 + REFRESH_STARTUP_DELAY_MS + 1)
    await sweep(store)
    expect(probeGitRemoteIdentity).toHaveBeenCalledTimes(4)

    await sweep(store)
    expect(probeGitRemoteIdentity).toHaveBeenCalledTimes(6)
  })

  it('does not re-probe folder workspaces', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue(resolvedProbe)
    const store = makeStore(makeRepo({ kind: 'folder', gitRemoteIdentity: remoteIdentity }))

    await sweep(store)
    vi.setSystemTime(1_000 + REFRESH_STARTUP_DELAY_MS + REFRESH_TTL_MS + 1)
    await sweep(store)

    expect(probeGitRemoteIdentity).not.toHaveBeenCalled()
  })

  it('forgets a removed repo location so its deadline cannot outlive the repo', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue(resolvedProbe)
    const repo = makeRepo({ gitRemoteIdentity: remoteIdentity })
    const live: Repo[] = [repo]
    const store: RepoIdentityStore = {
      getRepos: () => live,
      getRepo: (id) => live.find((candidate) => candidate.id === id),
      updateRepo: () => null
    }

    // Seeds the startup-delay deadline for this location.
    await sweep(store)
    live.length = 0
    await sweep(store)
    live.push(repo)
    // Past the seeded deadline: a retained entry would make this location due at once.
    vi.setSystemTime(1_000 + REFRESH_STARTUP_DELAY_MS + 1)
    await sweep(store)

    expect(probeGitRemoteIdentity).not.toHaveBeenCalled()
  })

  it('keeps a surviving repo backoff when a sibling repo is removed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue(resolvedProbe)
    const kept = makeRepo({ gitRemoteIdentity: remoteIdentity })
    const removed = makeRepo({
      id: 'repo-2',
      path: '/workspace/other-app',
      gitRemoteIdentity: remoteIdentity
    })
    const live: Repo[] = [kept, removed]
    const store: RepoIdentityStore = {
      getRepos: () => live,
      getRepo: (id) => live.find((candidate) => candidate.id === id),
      updateRepo: () => null
    }

    await sweep(store)
    vi.setSystemTime(1_000 + REFRESH_STARTUP_DELAY_MS + 1)
    await sweep(store)
    expect(probeGitRemoteIdentity).toHaveBeenCalledTimes(2)

    live.splice(1, 1)
    await sweep(store)

    // The kept repo is still inside its 6h refresh window, so pruning its sibling
    // must not make it due again.
    expect(probeGitRemoteIdentity).toHaveBeenCalledTimes(2)
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

describe('retiring probes for removed repos', () => {
  function makeMutableStore(live: Repo[]): RepoIdentityStore & {
    updateRepo: ReturnType<typeof vi.fn>
  } {
    return {
      getRepos: () => live,
      getRepo: (id) => live.find((candidate) => candidate.id === id),
      updateRepo: vi.fn((id, updates) => {
        const target = live.find((candidate) => candidate.id === id)
        if (!target) {
          return null
        }
        Object.assign(target, updates)
        return target
      })
    }
  }

  function probeSignal(callIndex: number): AbortSignal {
    const signal = vi.mocked(probeGitRemoteIdentity).mock.calls[callIndex]?.[2]?.signal
    if (!signal) {
      throw new Error(`probe call ${callIndex} was made without an abort signal`)
    }
    return signal
  }

  it('aborts the in-flight probe of a repo that was removed', () => {
    // Never resolves: a probe wedged on a hung network path is exactly the case that must not
    // outlive its repo. Do not flush here — flushing awaits this promise and would hang the suite.
    vi.mocked(probeGitRemoteIdentity).mockReturnValue(new Promise(() => {}))
    const repo = makeRepo()
    const live: Repo[] = [repo]
    const store = makeMutableStore(live)

    enrichMissingRepoGitRemoteIdentities(store)
    const signal = probeSignal(0)
    expect(signal.aborted).toBe(false)

    live.length = 0
    enrichMissingRepoGitRemoteIdentities(store)

    expect(signal.aborted).toBe(true)
  })

  it('probes again when the same location is re-added after its probe was retired', async () => {
    const wedged = deferred<GitRemoteIdentityProbe>()
    vi.mocked(probeGitRemoteIdentity)
      .mockReturnValueOnce(wedged.promise)
      .mockResolvedValue(resolvedProbe)
    const repo = makeRepo()
    const live: Repo[] = [repo]
    const store = makeMutableStore(live)

    enrichMissingRepoGitRemoteIdentities(store)
    live.length = 0
    enrichMissingRepoGitRemoteIdentities(store)
    // The retired probe settles late, as an abort-killed git does.
    wedged.resolve(resolvedProbe)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    live.push(repo)
    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(probeGitRemoteIdentity).toHaveBeenCalledTimes(2)
    expect(repo.gitRemoteIdentity).toEqual(remoteIdentity)
  })

  it('does not let a retired probe write an identity or re-seed a retry deadline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const wedged = deferred<GitRemoteIdentityProbe>()
    vi.mocked(probeGitRemoteIdentity)
      .mockReturnValueOnce(wedged.promise)
      .mockResolvedValue(resolvedProbe)
    const repo = makeRepo()
    const live: Repo[] = [repo]
    const store = makeMutableStore(live)

    enrichMissingRepoGitRemoteIdentities(store)
    live.length = 0
    enrichMissingRepoGitRemoteIdentities(store)
    wedged.resolve(resolvedProbe)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(store.updateRepo).not.toHaveBeenCalled()

    // Same instant: a deadline re-seeded by the retired probe would suppress this probe entirely.
    live.push(repo)
    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(probeGitRemoteIdentity).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent sweeps instead of running one pass per list call', async () => {
    const first = deferred<GitRemoteIdentityProbe>()
    vi.mocked(probeGitRemoteIdentity)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(resolvedProbe)
    const live: Repo[] = [makeRepo(), makeRepo({ id: 'repo-2', path: '/workspace/other-app' })]
    const store = makeMutableStore(live)
    // The three list handlers share one broadcast reference (ipc/repos.ts) while the runtime RPC
    // passes its own, so the shared one catches stacked passes and the distinct one catches a
    // coalesced caller being dropped.
    const listHandlersChanged = vi.fn()
    const runtimeChanged = vi.fn()

    enrichMissingRepoGitRemoteIdentities(store, { onChanged: listHandlersChanged })
    enrichMissingRepoGitRemoteIdentities(store, { onChanged: listHandlersChanged })
    enrichMissingRepoGitRemoteIdentities(store, { onChanged: runtimeChanged })

    first.resolve(resolvedProbe)
    await drainEnrichmentSweep()

    // Each stacked sweep would otherwise re-run the whole candidate loop and re-broadcast.
    expect(listHandlersChanged).toHaveBeenCalledTimes(1)
    expect(runtimeChanged).toHaveBeenCalledTimes(1)
  })

  it('still notifies a caller whose sweep was coalesced into one already running', async () => {
    const first = deferred<GitRemoteIdentityProbe>()
    vi.mocked(probeGitRemoteIdentity).mockReturnValue(first.promise)
    const store = makeMutableStore([makeRepo()])
    const listHandlerChanged = vi.fn()
    // The runtime RPC caller also drops a resolved-worktree cache, so it must not be dropped.
    const runtimeChanged = vi.fn()

    enrichMissingRepoGitRemoteIdentities(store, { onChanged: listHandlerChanged })
    enrichMissingRepoGitRemoteIdentities(store, { onChanged: runtimeChanged })

    first.resolve(resolvedProbe)
    await drainEnrichmentSweep()

    expect(listHandlerChanged).toHaveBeenCalledTimes(1)
    expect(runtimeChanged).toHaveBeenCalledTimes(1)
  })
})
