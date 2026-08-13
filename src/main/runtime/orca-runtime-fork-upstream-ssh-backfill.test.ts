// Legacy SSH forks backfill only after a ready provider publishes connected (#12967).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/types'
import type { SshConnectionState } from '../../shared/ssh-types'
import { OrcaRuntimeService } from './orca-runtime'
import { getRepoUpstream } from '../github/client'
import {
  getSshGitProvider,
  registerSshGitProvider,
  unregisterSshGitProvider
} from '../providers/ssh-git-dispatch'

const getRepoUpstreamMock = vi.hoisted(() => vi.fn())

vi.mock('../github/client', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getRepoUpstream: getRepoUpstreamMock
}))

const UPSTREAM = { owner: 'stablyai', repo: 'orca' }
const registeredConnectionIds = new Set<string>()

function makeRepo(overrides: Partial<Repo>): Repo {
  return {
    id: 'repo',
    path: '/srv/orca',
    displayName: 'orca',
    badgeColor: '#000',
    addedAt: 1,
    kind: 'git',
    ...overrides
  } as Repo
}

function createRuntime(repos: Repo[]) {
  const updateRepo = vi.fn((id: string, updates: Partial<Repo>) => {
    const repo = repos.find((entry) => entry.id === id)
    if (!repo) {
      return null
    }
    Object.assign(repo, updates)
    return repo
  })
  const runtime = new OrcaRuntimeService({
    getRepos: () => [...repos],
    getRepo: (id: string) => repos.find((repo) => repo.id === id) ?? null,
    updateRepo,
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => null,
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getGitHubCache: () => null,
    getSettings: () => ({})
  } as never)
  return { runtime, repos, updateRepo }
}

function sshState(targetId: string, status: SshConnectionState['status']): SshConnectionState {
  return { targetId, status, error: null, reconnectAttempt: 0 }
}

function notifyConnected(runtime: OrcaRuntimeService, targetId: string): void {
  registeredConnectionIds.add(targetId)
  if (!getSshGitProvider(targetId)) {
    registerSshGitProvider(targetId, {} as never)
  }
  runtime.notifySshStateChanged(targetId, sshState(targetId, 'connected'))
}

function notifyDisconnected(runtime: OrcaRuntimeService, targetId: string): void {
  unregisterSshGitProvider(targetId)
  runtime.notifySshStateChanged(targetId, sshState(targetId, 'disconnected'))
}

// Why: fire-and-forget production work exposes no handle, so tests flush its microtask queue.
async function drainBackfill(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  getRepoUpstreamMock.mockReset()
  getRepoUpstreamMock.mockResolvedValue(null)
})

afterEach(() => {
  for (const connectionId of registeredConnectionIds) {
    unregisterSshGitProvider(connectionId)
  }
  registeredConnectionIds.clear()
})

describe('fork upstream backfill for SSH repos', () => {
  it('resolves the upstream when the connection comes up', async () => {
    getRepoUpstreamMock.mockResolvedValue(UPSTREAM)
    const { runtime, repos } = createRuntime([makeRepo({ id: 'ssh-fork', connectionId: 'ssh-1' })])

    notifyConnected(runtime, 'ssh-1')
    await drainBackfill()

    expect(getRepoUpstream).toHaveBeenCalledWith('/srv/orca', 'ssh-1')
    expect(repos[0].upstream).toEqual(UPSTREAM)
  })

  it('migrates the auto-detected origin avatar to the upstream, like the local pass', async () => {
    getRepoUpstreamMock.mockResolvedValue(UPSTREAM)
    const { runtime, repos } = createRuntime([
      makeRepo({
        id: 'ssh-fork',
        connectionId: 'ssh-1',
        repoIcon: { type: 'image', src: 'https://avatars/fork.png', source: 'github' }
      }),
      makeRepo({
        id: 'ssh-chosen',
        path: '/srv/other',
        connectionId: 'ssh-1',
        repoIcon: { type: 'emoji', emoji: '🦈' }
      })
    ])

    notifyConnected(runtime, 'ssh-1')
    await drainBackfill()

    expect(repos[0].repoIcon).toEqual({
      type: 'image',
      src: 'https://github.com/stablyai.png?size=64',
      source: 'github',
      label: 'stablyai/orca'
    })
    expect(repos[1].repoIcon).toEqual({ type: 'emoji', emoji: '🦈' })
  })

  it('skips folder repos, other connections, and already-resolved repos', async () => {
    const { runtime } = createRuntime([
      makeRepo({ id: 'folder', connectionId: 'ssh-1', kind: 'folder' }),
      makeRepo({ id: 'other-host', path: '/srv/b', connectionId: 'ssh-2' }),
      makeRepo({ id: 'local', path: '/home/a' }),
      makeRepo({ id: 'resolved', path: '/srv/c', connectionId: 'ssh-1', upstream: null })
    ])

    notifyConnected(runtime, 'ssh-1')
    await drainBackfill()

    expect(getRepoUpstream).not.toHaveBeenCalled()
  })

  it('leaves best-effort null unresolved without retrying every reconnect', async () => {
    const { runtime, repos, updateRepo } = createRuntime([
      makeRepo({ id: 'ssh-fork', connectionId: 'ssh-1' })
    ])

    notifyConnected(runtime, 'ssh-1')
    runtime.notifySshStateChanged('ssh-1', sshState('ssh-1', 'connected'))
    await drainBackfill()
    notifyDisconnected(runtime, 'ssh-1')
    notifyConnected(runtime, 'ssh-1')
    await drainBackfill()

    expect(getRepoUpstream).toHaveBeenCalledTimes(1)
    expect(repos[0].upstream).toBeUndefined()
    expect(updateRepo).not.toHaveBeenCalled()
  })

  it('retries on the next connect when the probe threw', async () => {
    getRepoUpstreamMock.mockRejectedValueOnce(new Error('ssh channel closed'))
    const { runtime, repos } = createRuntime([makeRepo({ id: 'ssh-fork', connectionId: 'ssh-1' })])

    notifyConnected(runtime, 'ssh-1')
    await drainBackfill()
    expect(repos[0].upstream).toBeUndefined()

    getRepoUpstreamMock.mockResolvedValue(UPSTREAM)
    notifyDisconnected(runtime, 'ssh-1')
    notifyConnected(runtime, 'ssh-1')
    await drainBackfill()

    expect(repos[0].upstream).toEqual(UPSTREAM)
  })

  it('retries a newer provider generation when reconnect wins the failure race', async () => {
    let rejectProbe: ((error: Error) => void) | undefined
    getRepoUpstreamMock
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectProbe = reject
          })
      )
      .mockResolvedValueOnce(UPSTREAM)
    const { runtime, repos } = createRuntime([makeRepo({ id: 'ssh-fork', connectionId: 'ssh-1' })])

    notifyConnected(runtime, 'ssh-1')
    await drainBackfill()
    notifyDisconnected(runtime, 'ssh-1')
    notifyConnected(runtime, 'ssh-1')
    rejectProbe?.(new Error('old provider disconnected'))
    await drainBackfill()

    expect(getRepoUpstream).toHaveBeenCalledTimes(2)
    expect(repos[0].upstream).toEqual(UPSTREAM)
  })

  it('discards a stale null returned after the provider changed', async () => {
    let resolveProbe: ((value: null) => void) | undefined
    getRepoUpstreamMock
      .mockImplementationOnce(
        () =>
          new Promise<null>((resolve) => {
            resolveProbe = resolve
          })
      )
      .mockResolvedValueOnce(UPSTREAM)
    const { runtime, repos } = createRuntime([makeRepo({ id: 'ssh-fork', connectionId: 'ssh-1' })])

    notifyConnected(runtime, 'ssh-1')
    await drainBackfill()
    notifyDisconnected(runtime, 'ssh-1')
    notifyConnected(runtime, 'ssh-1')
    resolveProbe?.(null)
    await drainBackfill()

    expect(getRepoUpstream).toHaveBeenCalledTimes(2)
    expect(repos[0].upstream).toEqual(UPSTREAM)
  })

  it('lets a healthy host pass a stalled host while bounding concurrent probes', async () => {
    let inFlight = 0
    let maxInFlight = 0
    let releaseA: (() => void) | undefined
    let releaseB: (() => void) | undefined
    getRepoUpstreamMock.mockImplementation(async (path) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        if (path === '/srv/a') {
          await new Promise<void>((resolve) => {
            releaseA = resolve
          })
        }
        if (path === '/srv/b') {
          await new Promise<void>((resolve) => {
            releaseB = resolve
          })
        }
        return UPSTREAM
      } finally {
        inFlight -= 1
      }
    })
    const { runtime, repos } = createRuntime([
      makeRepo({ id: 'a', path: '/srv/a', connectionId: 'ssh-1' }),
      makeRepo({ id: 'b', path: '/srv/b', connectionId: 'ssh-2' }),
      makeRepo({ id: 'c', path: '/srv/c', connectionId: 'ssh-3' })
    ])

    notifyConnected(runtime, 'ssh-1')
    notifyConnected(runtime, 'ssh-2')
    notifyConnected(runtime, 'ssh-3')
    await drainBackfill()

    expect(getRepoUpstream).toHaveBeenCalledTimes(2)
    expect(getRepoUpstream).not.toHaveBeenCalledWith('/srv/c', 'ssh-3')
    expect(maxInFlight).toBe(2)

    releaseB?.()
    await drainBackfill()

    expect(repos[1].upstream).toEqual(UPSTREAM)
    expect(repos[2].upstream).toEqual(UPSTREAM)
    expect(repos[0].upstream).toBeUndefined()
    expect(maxInFlight).toBe(2)

    releaseA?.()
    await drainBackfill()

    expect(repos[0].upstream).toEqual(UPSTREAM)
  })

  it('does not persist a stale null when a queued provider disconnects', async () => {
    let releaseA: (() => void) | undefined
    let releaseB: (() => void) | undefined
    getRepoUpstreamMock.mockImplementation((path) => {
      if (path === '/srv/a') {
        return new Promise<null>((resolve) => {
          releaseA = () => resolve(null)
        })
      }
      if (path === '/srv/b') {
        return new Promise<null>((resolve) => {
          releaseB = () => resolve(null)
        })
      }
      return Promise.resolve(UPSTREAM)
    })
    const { runtime, repos } = createRuntime([
      makeRepo({ id: 'a', path: '/srv/a', connectionId: 'ssh-1' }),
      makeRepo({ id: 'b', path: '/srv/b', connectionId: 'ssh-2' }),
      makeRepo({ id: 'c', path: '/srv/c', connectionId: 'ssh-3' })
    ])

    notifyConnected(runtime, 'ssh-1')
    notifyConnected(runtime, 'ssh-2')
    await drainBackfill()
    expect(getRepoUpstream).toHaveBeenCalledTimes(2)

    notifyConnected(runtime, 'ssh-3')
    notifyDisconnected(runtime, 'ssh-3')
    releaseA?.()
    await drainBackfill()

    expect(repos[2].upstream).toBeUndefined()
    expect(getRepoUpstream).not.toHaveBeenCalledWith('/srv/c', 'ssh-3')

    notifyConnected(runtime, 'ssh-3')
    await drainBackfill()

    expect(repos[2].upstream).toEqual(UPSTREAM)

    releaseB?.()
    await drainBackfill()
  })

  it('returns from the connect notification without waiting on the probe', async () => {
    let resolveProbe: ((value: unknown) => void) | undefined
    getRepoUpstreamMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve
        })
    )
    const { runtime, repos } = createRuntime([makeRepo({ id: 'ssh-fork', connectionId: 'ssh-1' })])

    notifyConnected(runtime, 'ssh-1')

    expect(getRepoUpstream).not.toHaveBeenCalled()
    await drainBackfill()
    expect(getRepoUpstream).toHaveBeenCalledOnce()
    expect(repos[0].upstream).toBeUndefined()

    resolveProbe?.(UPSTREAM)
    await drainBackfill()
    expect(repos[0].upstream).toEqual(UPSTREAM)
  })

  it('leaves the startup pass local-only', async () => {
    const { runtime } = createRuntime([
      makeRepo({ id: 'local', path: '/home/a' }),
      makeRepo({ id: 'ssh-fork', connectionId: 'ssh-1' })
    ])

    runtime.setNotifier({ reposChanged: vi.fn() } as never)
    await drainBackfill()

    expect(getRepoUpstream).toHaveBeenCalledExactlyOnceWith('/home/a', null)
  })
})
