import { afterEach, describe, expect, it, vi } from 'vitest'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import type { GitRemoteIdentity } from '../../../shared/git/remotes/git-remote-identity'
import type { Repo } from '../../../shared/repository/repo-types'
import type { RepoHostTarget } from '../../../shared/repository/repo-host-identity'
import { repoTarget } from '../../persistence/repo-host-target-matcher.test-fixture'
import { type GitRemoteIdentityProbe, probeGitRemoteIdentity } from './repo-git-remote-identity'

import type * as DistroGate from '../../wsl/discovery/wsl-background-distro-gate'
import type { WslDistroRunningState } from '../../wsl/discovery/wsl-background-distro-gate'
import '../../git/command-runner/host-routing/local-git-runtime-route'
import {
  enrichMissingRepoGitRemoteIdentities,
  flushRepoGitRemoteIdentityEnrichmentForTests,
  resetRepoGitRemoteIdentityEnrichmentForTests
} from './repo-git-remote-identity-enrichment'

vi.mock('./repo-git-remote-identity', () => ({
  probeGitRemoteIdentity: vi.fn()
}))
const distroGate = vi.hoisted((): { state: WslDistroRunningState } => ({ state: 'running' }))
vi.mock('../../wsl/discovery/wsl-background-distro-gate', async (importOriginal) => ({
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
})
