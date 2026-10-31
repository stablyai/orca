import { afterEach, describe, expect, it, vi } from 'vitest'
import { getRepoExecutionHostId } from '../shared/execution-host'
import type { GitRemoteIdentity } from '../shared/git-remote-identity'
import type { Repo } from '../shared/repo-types'
import type { RepoHostTarget } from '../shared/repo-host-identity'
import { repoTarget } from './persistence/repo-host-target-matcher.test-fixture'
import { type GitRemoteIdentityProbe, probeGitRemoteIdentity } from './repo-git-remote-identity'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../shared/wsl-host-internal-gate'
import type * as DistroGate from './wsl-background-distro-gate'
import type { WslDistroRunningState } from './wsl-background-distro-gate'
import { setLocalGitRuntimeRouter } from './git/command-runner/local-git-runtime-route'
import {
  enrichMissingRepoGitRemoteIdentities,
  flushRepoGitRemoteIdentityEnrichmentForTests,
  resetRepoGitRemoteIdentityEnrichmentForTests
} from './repo-git-remote-identity-enrichment'

vi.mock('./repo-git-remote-identity', () => ({
  probeGitRemoteIdentity: vi.fn()
}))
const distroGate = vi.hoisted((): { state: WslDistroRunningState } => ({ state: 'running' }))
vi.mock('./wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof DistroGate>()),
  readWslDistroRunningState: async () => distroGate.state
}))

type RepoIdentityStore = {
  getRepos: () => Repo[]
  getRepo: (id: string) => Repo | undefined
  updateRepo: (
    target: RepoHostTarget,
    updates: Pick<Partial<Repo>, 'gitRemoteIdentity'>
  ) => Repo | null
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
    // Match the real store: writes use the row's own host stamp.
    updateRepo: vi.fn((target: RepoHostTarget, updates) => {
      const row = repos.find(
        (candidate) =>
          candidate.id === target.id &&
          getRepoExecutionHostId(candidate) === getRepoExecutionHostId(target)
      )
      if (!row) {
        return null
      }
      Object.assign(row, updates)
      return row
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

  function drivePathRepoUnderWslRuntime(): { repo: Repo; store: RepoIdentityStore } {
    const repo = makeRepo({ path: String.raw`C:\src\app` })
    const store = {
      ...makeStore(repo),
      getProjects: () => [
        {
          id: 'p1',
          displayName: 'app',
          badgeColor: '',
          sourceRepoIds: [repo.id],
          createdAt: 0,
          updatedAt: 0
        }
      ],
      getSettings: () => ({
        localWindowsRuntimeDefault: { kind: 'wsl' as const, distro: 'Ubuntu' }
      })
    }
    return { repo, store }
  }

  async function sweepOnWindows(store: RepoIdentityStore, gate: string): Promise<void> {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, gate)
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      await sweep(store)
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
      vi.unstubAllEnvs()
      distroGate.state = 'running'
    }
  }

  it.each([
    ['with the distro Git', '1', 'Ubuntu'],
    ['with host Git, as before, while WSL hosts are off', '', undefined]
  ])('probes a drive project whose runtime is WSL %s', async (_case, gate, distro) => {
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue(resolvedProbe)
    const { repo, store } = drivePathRepoUnderWslRuntime()
    await sweepOnWindows(store, gate)

    expect(probeGitRemoteIdentity).toHaveBeenCalledWith(repo.path, 'local', expect.any(Object))
    expect(vi.mocked(probeGitRemoteIdentity).mock.calls[0]?.[2]?.wslDistro).toBe(distro)
  })

  it("never probes a drive project whose WSL runtime's distro is stopped, so the sweep can't boot it", async () => {
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue(resolvedProbe)
    distroGate.state = 'stopped'
    const { store } = drivePathRepoUnderWslRuntime()
    await sweepOnWindows(store, '1')

    expect(probeGitRemoteIdentity).not.toHaveBeenCalled()
  })

  it.each([
    ['keeps its tier without the Git router', null, undefined],
    ['waits as background work with the Git router on', () => undefined, 'background']
  ])('sweeps a local repo: %s', async (_case, router, tier) => {
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue(resolvedProbe)
    setLocalGitRuntimeRouter(router)
    try {
      enrichMissingRepoGitRemoteIdentities(makeStore(makeRepo()))
    } finally {
      setLocalGitRuntimeRouter(null)
    }

    expect(vi.mocked(probeGitRemoteIdentity).mock.calls[0]?.[2]?.admissionTier).toBe(tier)
    await flushRepoGitRemoteIdentityEnrichmentForTests()
  })

  it('probes an SSH row that carries only executionHostId on its own host', async () => {
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

  it('never probes a runtime row that names a nested SSH target', async () => {
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue({ status: 'unavailable' })
    const store = makeStore(
      makeRepo({ connectionId: 'nested-1', executionHostId: 'runtime:env-a' })
    )

    await sweep(store)

    expect(probeGitRemoteIdentity).not.toHaveBeenCalled()
    expect(store.updateRepo).not.toHaveBeenCalled()
  })

  it('probes a self-addressed runtime row here and writes it back under its own stamp', async () => {
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue(resolvedProbe)
    const repo = makeRepo({ executionHostId: 'runtime:env-a' })
    const store = makeStore(repo)

    await sweep(store)

    expect(probeGitRemoteIdentity).toHaveBeenCalledWith(
      '/workspace/sample-app',
      'local',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(store.updateRepo).toHaveBeenCalledWith(repoTarget('repo-1', 'runtime:env-a'), {
      gitRemoteIdentity: remoteIdentity
    })
    expect(repo.gitRemoteIdentity).toEqual(remoteIdentity)
  })

  it('keeps same-path rows on two different SSH hosts from sharing one backoff', async () => {
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

    expect(store.updateRepo).toHaveBeenCalledWith(repoTarget('repo-1', 'local'), {
      gitRemoteIdentity: null
    })
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

    expect(store.updateRepo).toHaveBeenCalledWith(repoTarget('repo-1', 'local'), {
      gitRemoteIdentity: remoteIdentity
    })
  })

  it('does not re-probe a resolved identity before the refresh window elapses', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue(resolvedProbe)
    const store = makeStore(makeRepo({ gitRemoteIdentity: remoteIdentity }))

    // The first sweep schedules refreshes to avoid startup fan-out.
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

    expect(store.updateRepo).toHaveBeenCalledWith(repoTarget('repo-1', 'local'), {
      gitRemoteIdentity: movedIdentity
    })
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

    await sweep(store)
    live.length = 0
    await sweep(store)
    live.push(repo)
    // Retaining a removed location would make it immediately due when re-added.
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
      updateRepo: vi.fn(({ id }: RepoHostTarget, updates) => {
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
    // Do not flush this intentionally wedged promise; the flush would hang.
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
    // An aborted git probe can still settle late.
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

    // A retired probe must not re-seed backoff for this location.
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
    // List handlers share a callback; runtime RPC uses a distinct one.
    const listHandlersChanged = vi.fn()
    const runtimeChanged = vi.fn()

    enrichMissingRepoGitRemoteIdentities(store, { onChanged: listHandlersChanged })
    enrichMissingRepoGitRemoteIdentities(store, { onChanged: listHandlersChanged })
    enrichMissingRepoGitRemoteIdentities(store, { onChanged: runtimeChanged })

    first.resolve(resolvedProbe)
    await drainEnrichmentSweep()

    expect(listHandlersChanged).toHaveBeenCalledTimes(1)
    expect(runtimeChanged).toHaveBeenCalledTimes(1)
  })
})
