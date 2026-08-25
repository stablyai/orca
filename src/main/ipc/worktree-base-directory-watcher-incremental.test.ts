import { realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'

const { providerGenerations, providerGenerationListeners } = vi.hoisted(() => ({
  providerGenerations: new Map<string, number>(),
  providerGenerationListeners: new Set<(connectionId: string) => void>()
}))

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async () => ''),
  realpath: vi.fn(async (path: string) => path),
  stat: vi.fn(async () => ({ isDirectory: () => true }))
}))

vi.mock('./worktree-base-directory-poller', () => ({
  createWorktreePollerWindowVisibility: vi.fn(() => ({
    isWindowVisible: () => true,
    onWindowBecameVisible: () => () => {}
  })),
  startWorktreeBaseDirectoryPoller: vi.fn()
}))

vi.mock('./worktree-remote', () => ({
  notifyWorktreeGitStatusMetadataChanged: vi.fn(),
  notifyWorktreeHeadIdentitiesChanged: vi.fn(),
  notifyWorktreesChanged: vi.fn()
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: vi.fn(),
  getSshFilesystemProviderGeneration: vi.fn(
    (connectionId: string) => providerGenerations.get(connectionId) ?? 0
  ),
  onSshFilesystemProviderGenerationChanged: vi.fn((listener: (connectionId: string) => void) => {
    providerGenerationListeners.add(listener)
    return () => providerGenerationListeners.delete(listener)
  })
}))

vi.mock('./worktree-head-identity-reader', () => ({
  readGitCommonHeadIdentities: vi.fn(async () => [])
}))

import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { startWorktreeBaseDirectoryPoller } from './worktree-base-directory-poller'
import { notifyWorktreesChanged } from './worktree-remote'
import {
  disposeWorktreeBaseDirectoryWatchers,
  scheduleWorktreeBaseDirectoryWatcherSync,
  setWorktreeBaseDirectoryWatcherSyncContext,
  syncWorktreeBaseDirectoryWatchers
} from './worktree-base-directory-watcher'

const absolutePath = (...parts: string[]): string => join(sep, ...parts)
const WORKTREE_ROOT = absolutePath('workspace', 'worktrees')
const settings = {
  workspaceDir: WORKTREE_ROOT,
  nestWorkspaces: true
} as GlobalSettings
const unsubscribeMocks = new Map<string, ReturnType<typeof vi.fn>>()
const pollerRepoGetters = new Map<string, () => ReadonlyMap<string, unknown>>()

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: absolutePath('workspace', 'projects', 'project'),
    displayName: 'Project',
    badgeColor: '#000000',
    addedAt: 1,
    ...overrides
  } as Repo
}

function makeRepoFleet(): Repo[] {
  return [
    ...Array.from({ length: 50 }, (_, index) =>
      makeRepo({
        id: `repo-${index}`,
        path: absolutePath('workspace', 'projects', `local-${index}`)
      })
    ),
    ...Array.from({ length: 25 }, (_, index) =>
      makeRepo({ id: `repo-${index}`, path: `/srv/a/repo-${index}`, connectionId: 'ssh-a' })
    ),
    ...Array.from({ length: 25 }, (_, index) =>
      makeRepo({
        id: `repo-${index + 25}`,
        path: `/srv/b/repo-${index + 25}`,
        connectionId: 'ssh-b'
      })
    )
  ]
}

function makeStore(repos: Repo[]) {
  return {
    getSettings: () => settings,
    getRepos: () => repos
  }
}

function makeWindow(options: { destroyed?: () => boolean } = {}) {
  return {
    isDestroyed: () => options.destroyed?.() ?? false,
    webContents: { send: vi.fn() }
  }
}

function makeRemoteFilesystemProvider() {
  const unwatch = vi.fn()
  const callbacks = new Map<string, (events: never[]) => void>()
  return {
    stat: vi.fn(async () => ({ type: 'directory', size: 0, mtime: 0 })),
    realpath: vi.fn(async (path: string) => path),
    readFile: vi.fn(async () => ({ content: '', isBinary: false })),
    watch: vi.fn(async (path: string, callback: (events: never[]) => void) => {
      callbacks.set(path, callback)
      return unwatch
    }),
    unwatch,
    callbacks
  }
}

describe('incremental worktree base directory watcher synchronization', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    settings.workspaceDir = WORKTREE_ROOT
    settings.nestWorkspaces = true
    unsubscribeMocks.clear()
    pollerRepoGetters.clear()
    providerGenerations.clear()
    providerGenerationListeners.clear()
    vi.mocked(stat).mockImplementation(async () => ({ isDirectory: () => true }) as never)
    vi.mocked(getSshFilesystemProvider).mockReturnValue(undefined)
    vi.mocked(realpath).mockImplementation(async (path) => String(path))
    vi.mocked(startWorktreeBaseDirectoryPoller).mockImplementation(async (target, getRepos) => {
      const unsubscribe = vi.fn(async () => {})
      unsubscribeMocks.set(target.path, unsubscribe)
      pollerRepoGetters.set(target.path, getRepos)
      return { unsubscribe }
    })
  })

  afterEach(async () => {
    await disposeWorktreeBaseDirectoryWatchers()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  function useFleetProviders() {
    const providerA = makeRemoteFilesystemProvider()
    const providerB = makeRemoteFilesystemProvider()
    vi.mocked(getSshFilesystemProvider).mockImplementation((connectionId) =>
      connectionId === 'ssh-a' ? (providerA as never) : (providerB as never)
    )
    return { providerA, providerB }
  }

  it('probes only one host-qualified repo in a 100-repo local and SSH fleet', async () => {
    const repos = makeRepoFleet()
    const store = makeStore(repos)
    const mainWindow = makeWindow()
    const { providerA, providerB } = useFleetProviders()
    await syncWorktreeBaseDirectoryWatchers(store as never, mainWindow as never)
    vi.mocked(stat).mockClear()
    vi.mocked(realpath).mockClear()
    providerA.stat.mockClear()
    providerB.stat.mockClear()

    repos[3] = { ...repos[3], path: absolutePath('workspace', 'renamed', 'local-3') }
    await syncWorktreeBaseDirectoryWatchers(store as never, mainWindow as never, {
      dirtyRepoIdentities: [{ repoId: 'repo-3', hostId: 'local' }]
    })

    expect(stat).toHaveBeenCalledTimes(2)
    expect(realpath).toHaveBeenCalledTimes(2)
    expect(providerA.stat).not.toHaveBeenCalled()
    expect(providerB.stat).not.toHaveBeenCalled()
  })

  it('removes only a deleted repo membership without re-probing the fleet', async () => {
    const repos = makeRepoFleet()
    const deletedPath = repos[3].path
    const store = makeStore(repos)
    const { providerA, providerB } = useFleetProviders()
    await syncWorktreeBaseDirectoryWatchers(store as never, makeWindow() as never)
    vi.mocked(stat).mockClear()
    providerA.stat.mockClear()
    providerB.stat.mockClear()

    repos.splice(3, 1)
    await syncWorktreeBaseDirectoryWatchers(store as never, makeWindow() as never, {
      dirtyRepoIdentities: [{ repoId: 'repo-3', hostId: 'local' }]
    })

    expect(stat).not.toHaveBeenCalled()
    expect(providerA.stat).not.toHaveBeenCalled()
    expect(providerB.stat).not.toHaveBeenCalled()
    expect([...pollerRepoGetters.get(WORKTREE_ROOT)!().keys()]).toHaveLength(49)
    expect(pollerRepoGetters.get(WORKTREE_ROOT)!().has('repo-3')).toBe(false)
    expect(pollerRepoGetters.get(WORKTREE_ROOT)!().has('repo-4')).toBe(true)
    expect(unsubscribeMocks.get(join(deletedPath, '.git'))).toHaveBeenCalledOnce()
    expect(unsubscribeMocks.get(join(repos[3].path, '.git'))).not.toHaveBeenCalled()
  })

  it('fully rebuilds every target for root and nesting settings', async () => {
    const repos = makeRepoFleet()
    const store = makeStore(repos)
    const { providerA, providerB } = useFleetProviders()
    await syncWorktreeBaseDirectoryWatchers(store as never, makeWindow() as never)

    const clearProbeCounts = () => {
      vi.mocked(stat).mockClear()
      providerA.stat.mockClear()
      providerB.stat.mockClear()
    }
    const expectFullProbe = () => {
      expect(stat).toHaveBeenCalledTimes(100)
      expect(providerA.stat).toHaveBeenCalledTimes(50)
      expect(providerB.stat).toHaveBeenCalledTimes(50)
    }
    clearProbeCounts()
    settings.nestWorkspaces = false
    await syncWorktreeBaseDirectoryWatchers(store as never, makeWindow() as never, {
      fullRebuild: true
    })
    expectFullProbe()

    clearProbeCounts()
    settings.workspaceDir = absolutePath('workspace', 'new-worktrees')
    await syncWorktreeBaseDirectoryWatchers(store as never, makeWindow() as never, {
      fullRebuild: true
    })
    expectFullProbe()
  })

  it('invalidates only a reconnected SSH host, then only a path-changed repo', async () => {
    const repos = makeRepoFleet()
    const store = makeStore(repos)
    const mainWindow = makeWindow()
    const { providerA, providerB } = useFleetProviders()
    setWorktreeBaseDirectoryWatcherSyncContext(store as never, mainWindow as never)
    await syncWorktreeBaseDirectoryWatchers(store as never, mainWindow as never)
    vi.mocked(stat).mockClear()
    providerA.stat.mockClear()
    providerB.stat.mockClear()
    providerA.watch.mockClear()

    providerGenerations.set('ssh-a', 1)
    for (const listener of providerGenerationListeners) {
      listener('ssh-a')
    }
    await vi.advanceTimersByTimeAsync(100)
    await vi.waitFor(() => expect(providerA.watch).toHaveBeenCalledTimes(26))
    expect(providerA.stat).toHaveBeenCalledTimes(50)
    expect(providerB.stat).not.toHaveBeenCalled()
    expect(stat).not.toHaveBeenCalled()

    providerA.stat.mockClear()
    const changedIndex = repos.findIndex(
      (repo) => repo.connectionId === 'ssh-b' && repo.id === 'repo-25'
    )
    repos[changedIndex] = { ...repos[changedIndex], path: '/srv/b/renamed-repo-25' }
    await syncWorktreeBaseDirectoryWatchers(store as never, mainWindow as never, {
      dirtyRepoIdentities: [{ repoId: 'repo-25', hostId: 'ssh:ssh-b' }]
    })
    expect(providerA.stat).not.toHaveBeenCalled()
    expect(providerB.stat).toHaveBeenCalledTimes(2)
    expect(stat).not.toHaveBeenCalled()
  })

  it('retains local watches across a transient target probe and installs after retry', async () => {
    const repo = makeRepo()
    const store = makeStore([repo])
    const mainWindow = makeWindow()
    await syncWorktreeBaseDirectoryWatchers(store as never, mainWindow as never)
    const oldRootUnsubscribe = unsubscribeMocks.get(WORKTREE_ROOT)
    const recoveredRoot = absolutePath('workspace', 'recovered-worktrees')
    let rootProbeFails = true
    vi.mocked(stat).mockImplementation(async (path) => {
      if (String(path) === recoveredRoot && rootProbeFails) {
        throw Object.assign(new Error('temporarily unavailable'), { code: 'EACCES' })
      }
      return { isDirectory: () => true } as never
    })
    vi.mocked(startWorktreeBaseDirectoryPoller).mockClear()

    repo.worktreeBasePath = recoveredRoot
    await syncWorktreeBaseDirectoryWatchers(store as never, mainWindow as never, {
      dirtyRepoIdentities: [{ repoId: repo.id, hostId: 'local' }]
    })
    expect(oldRootUnsubscribe).not.toHaveBeenCalled()
    expect(startWorktreeBaseDirectoryPoller).not.toHaveBeenCalled()

    rootProbeFails = false
    await vi.advanceTimersByTimeAsync(250)
    await vi.waitFor(() =>
      expect(startWorktreeBaseDirectoryPoller).toHaveBeenCalledWith(
        expect.objectContaining({ path: recoveredRoot }),
        expect.any(Function),
        expect.any(Function),
        expect.any(Object)
      )
    )
    expect(oldRootUnsubscribe).toHaveBeenCalledOnce()
  })

  it('retains SSH watches across transient probes and retries the affected repo', async () => {
    const repo = makeRepo({ connectionId: 'ssh-a', path: '/srv/a/project' })
    const store = makeStore([repo])
    const provider = makeRemoteFilesystemProvider()
    vi.mocked(getSshFilesystemProvider).mockReturnValue(provider as never)
    await syncWorktreeBaseDirectoryWatchers(store as never, makeWindow() as never)
    provider.stat.mockReset().mockRejectedValue(new Error('relay unavailable'))
    provider.unwatch.mockClear()

    await syncWorktreeBaseDirectoryWatchers(store as never, makeWindow() as never, {
      dirtyRepoIdentities: [{ repoId: repo.id, hostId: 'ssh:ssh-a' }]
    })
    expect(provider.unwatch).not.toHaveBeenCalled()
    provider.stat.mockResolvedValue({ type: 'directory', size: 0, mtime: 0 })

    await vi.advanceTimersByTimeAsync(250)
    await vi.waitFor(() => expect(provider.stat).toHaveBeenCalledTimes(4))
    expect(provider.unwatch).not.toHaveBeenCalled()
  })

  it('keeps an old local watch until a path replacement subscribes', async () => {
    const repo = makeRepo()
    const store = makeStore([repo])
    const mainWindow = makeWindow()
    await syncWorktreeBaseDirectoryWatchers(store as never, mainWindow as never)
    const oldRootUnsubscribe = unsubscribeMocks.get(WORKTREE_ROOT)
    const replacementRoot = absolutePath('workspace', 'replacement-worktrees')
    vi.mocked(startWorktreeBaseDirectoryPoller).mockRejectedValueOnce(
      new Error('native watcher capacity')
    )

    repo.worktreeBasePath = replacementRoot
    await syncWorktreeBaseDirectoryWatchers(store as never, mainWindow as never, {
      dirtyRepoIdentities: [{ repoId: repo.id, hostId: 'local' }]
    })
    expect(oldRootUnsubscribe).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(250)
    await vi.waitFor(() => expect(oldRootUnsubscribe).toHaveBeenCalledOnce())
  })

  it('keeps old SSH subscriptions until a replacement retry succeeds', async () => {
    const repo = makeRepo({ connectionId: 'ssh-a', path: '/srv/a/project' })
    const store = makeStore([repo])
    const oldProvider = makeRemoteFilesystemProvider()
    const newProvider = makeRemoteFilesystemProvider()
    vi.mocked(getSshFilesystemProvider).mockReturnValue(oldProvider as never)
    await syncWorktreeBaseDirectoryWatchers(store as never, makeWindow() as never)
    oldProvider.unwatch.mockClear()
    newProvider.watch.mockRejectedValue(new Error('watch transport unavailable'))
    vi.mocked(getSshFilesystemProvider).mockReturnValue(newProvider as never)
    providerGenerations.set('ssh-a', 1)

    await syncWorktreeBaseDirectoryWatchers(store as never, makeWindow() as never, {
      dirtyConnectionIds: ['ssh-a']
    })
    expect(oldProvider.unwatch).not.toHaveBeenCalled()
    expect(newProvider.watch).toHaveBeenCalledTimes(2)

    newProvider.watch.mockResolvedValue(newProvider.unwatch)
    await vi.advanceTimersByTimeAsync(250)
    await vi.waitFor(() => expect(oldProvider.unwatch).toHaveBeenCalledTimes(2))
  })

  it('refreshes retained reconnect routing for shared-root membership and window changes', async () => {
    const repoOne = makeRepo({ id: 'repo-one', connectionId: 'ssh-a', path: '/srv/a/one' })
    const repoTwo = makeRepo({ id: 'repo-two', connectionId: 'ssh-a', path: '/srv/a/two' })
    const repos = [repoOne, repoTwo]
    const store = makeStore(repos)
    let firstWindowDestroyed = false
    const firstWindow = makeWindow({ destroyed: () => firstWindowDestroyed })
    const nextWindow = makeWindow()
    const oldProvider = makeRemoteFilesystemProvider()
    const replacementProvider = makeRemoteFilesystemProvider()
    vi.mocked(getSshFilesystemProvider).mockReturnValue(oldProvider as never)
    await syncWorktreeBaseDirectoryWatchers(store as never, firstWindow as never)

    repos.splice(0, 1)
    repos.push(makeRepo({ id: 'repo-three', connectionId: 'ssh-a', path: '/srv/a/three' }))
    replacementProvider.watch.mockRejectedValue(new Error('replacement unavailable'))
    vi.mocked(getSshFilesystemProvider).mockReturnValue(replacementProvider as never)
    providerGenerations.set('ssh-a', 1)
    firstWindowDestroyed = true
    await syncWorktreeBaseDirectoryWatchers(store as never, nextWindow as never, {
      dirtyConnectionIds: ['ssh-a']
    })

    oldProvider.callbacks.get('/srv/a')?.([
      { kind: 'create', absolutePath: '/srv/a/external-worktree/.git' }
    ] as never[])
    await vi.advanceTimersByTimeAsync(300)
    expect(notifyWorktreesChanged).toHaveBeenCalledWith(nextWindow, 'repo-two')
    expect(notifyWorktreesChanged).toHaveBeenCalledWith(nextWindow, 'repo-three')
    expect(notifyWorktreesChanged).not.toHaveBeenCalledWith(expect.anything(), 'repo-one')
  })

  it('refreshes changed-key retention after failed replacements exhaust', async () => {
    const repoOne = makeRepo({ id: 'repo-one', connectionId: 'ssh-a', path: '/srv/a/one' })
    const repoTwo = makeRepo({ id: 'repo-two', connectionId: 'ssh-a', path: '/srv/a/two' })
    const repos = [repoOne, repoTwo]
    const store = makeStore(repos)
    let firstWindowDestroyed = false
    const firstWindow = makeWindow({ destroyed: () => firstWindowDestroyed })
    const nextWindow = makeWindow()
    const provider = makeRemoteFilesystemProvider()
    vi.mocked(getSshFilesystemProvider).mockReturnValue(provider as never)
    await syncWorktreeBaseDirectoryWatchers(store as never, firstWindow as never)

    repos.splice(
      0,
      repos.length,
      { ...repoTwo, path: '/srv/b/two' },
      makeRepo({ id: 'repo-three', connectionId: 'ssh-a', path: '/srv/b/three' })
    )
    provider.watch.mockImplementation(async (path, callback) => {
      if (path.startsWith('/srv/b')) {
        throw new Error('replacement unavailable')
      }
      provider.callbacks.set(path, callback)
      return provider.unwatch
    })
    firstWindowDestroyed = true
    await syncWorktreeBaseDirectoryWatchers(store as never, nextWindow as never, {
      dirtyConnectionIds: ['ssh-a']
    })
    await vi.advanceTimersByTimeAsync(250)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(4_000)
    const exhaustedAttempts = provider.watch.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(provider.watch).toHaveBeenCalledTimes(exhaustedAttempts)

    provider.callbacks.get('/srv/a')?.([
      { kind: 'create', absolutePath: '/srv/a/external-worktree/.git' }
    ] as never[])
    await vi.advanceTimersByTimeAsync(300)
    expect(notifyWorktreesChanged).toHaveBeenCalledWith(nextWindow, 'repo-two')
    expect(notifyWorktreesChanged).not.toHaveBeenCalledWith(expect.anything(), 'repo-three')
    expect(notifyWorktreesChanged).not.toHaveBeenCalledWith(expect.anything(), 'repo-one')
  })

  it('unions distinct failed replacement memberships for one retained shared watch', async () => {
    const repoOne = makeRepo({ id: 'repo-one', connectionId: 'ssh-a', path: '/srv/a/one' })
    const repoTwo = makeRepo({ id: 'repo-two', connectionId: 'ssh-a', path: '/srv/a/two' })
    const repos = [repoOne, repoTwo]
    const store = makeStore(repos)
    let firstWindowDestroyed = false
    const firstWindow = makeWindow({ destroyed: () => firstWindowDestroyed })
    const nextWindow = makeWindow()
    const provider = makeRemoteFilesystemProvider()
    vi.mocked(getSshFilesystemProvider).mockReturnValue(provider as never)
    await syncWorktreeBaseDirectoryWatchers(store as never, firstWindow as never)

    repos[0] = { ...repoOne, path: '/srv/b/one' }
    repos[1] = { ...repoTwo, path: '/srv/c/two' }
    provider.watch.mockImplementation(async (path, callback) => {
      if (path.startsWith('/srv/b') || path.startsWith('/srv/c')) {
        throw new Error('replacement unavailable')
      }
      provider.callbacks.set(path, callback)
      return provider.unwatch
    })
    firstWindowDestroyed = true
    await syncWorktreeBaseDirectoryWatchers(store as never, nextWindow as never, {
      dirtyConnectionIds: ['ssh-a']
    })

    provider.callbacks.get('/srv/a')?.([
      { kind: 'create', absolutePath: '/srv/a/external-worktree/.git' }
    ] as never[])
    await vi.advanceTimersByTimeAsync(300)
    expect(notifyWorktreesChanged).toHaveBeenCalledWith(nextWindow, 'repo-one')
    expect(notifyWorktreesChanged).toHaveBeenCalledWith(nextWindow, 'repo-two')
  })

  it('keeps inverse-merge failed replacements scoped to each old watch', async () => {
    const repoOne = makeRepo({ id: 'repo-one', connectionId: 'ssh-a', path: '/old-a/one' })
    const repoTwo = makeRepo({ id: 'repo-two', connectionId: 'ssh-a', path: '/old-b/two' })
    const repos = [repoOne, repoTwo]
    const store = makeStore(repos)
    const provider = makeRemoteFilesystemProvider()
    vi.mocked(getSshFilesystemProvider).mockReturnValue(provider as never)
    await syncWorktreeBaseDirectoryWatchers(store as never, makeWindow() as never)

    repos[0] = { ...repoOne, path: '/new/one' }
    repos[1] = { ...repoTwo, path: '/new/two' }
    provider.watch.mockImplementation(async (path, callback) => {
      if (path.startsWith('/new')) {
        throw new Error('replacement unavailable')
      }
      provider.callbacks.set(path, callback)
      return provider.unwatch
    })
    const nextWindow = makeWindow()
    await syncWorktreeBaseDirectoryWatchers(store as never, nextWindow as never, {
      dirtyConnectionIds: ['ssh-a']
    })

    provider.callbacks.get('/old-a')?.([
      { kind: 'create', absolutePath: '/old-a/external-worktree/.git' }
    ] as never[])
    await vi.advanceTimersByTimeAsync(300)
    expect(notifyWorktreesChanged).toHaveBeenCalledWith(nextWindow, 'repo-one')
    expect(notifyWorktreesChanged).not.toHaveBeenCalledWith(expect.anything(), 'repo-two')

    vi.mocked(notifyWorktreesChanged).mockClear()
    provider.callbacks.get('/old-b')?.([
      { kind: 'create', absolutePath: '/old-b/external-worktree/.git' }
    ] as never[])
    await vi.advanceTimersByTimeAsync(300)
    expect(notifyWorktreesChanged).toHaveBeenCalledWith(nextWindow, 'repo-two')
    expect(notifyWorktreesChanged).not.toHaveBeenCalledWith(expect.anything(), 'repo-one')
  })

  it('refreshes a same-version retry callback when the main window changes', async () => {
    const repo = makeRepo()
    const store = makeStore([repo])
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' })
    vi.mocked(stat).mockImplementation(async (path) => {
      if (String(path).endsWith('.git')) {
        throw missing
      }
      return { isDirectory: () => true } as never
    })
    vi.mocked(startWorktreeBaseDirectoryPoller)
      .mockRejectedValueOnce(new Error('watch unavailable in first window'))
      .mockRejectedValueOnce(new Error('watch unavailable in next window'))
    let firstWindowDestroyed = false
    const firstWindow = makeWindow({ destroyed: () => firstWindowDestroyed })
    const nextWindow = makeWindow()

    await syncWorktreeBaseDirectoryWatchers(store as never, firstWindow as never)
    await syncWorktreeBaseDirectoryWatchers(store as never, nextWindow as never, {
      dirtyRepoIdentities: [{ repoId: repo.id, hostId: 'local' }]
    })
    firstWindowDestroyed = true
    await vi.advanceTimersByTimeAsync(250)
    await vi.waitFor(() => expect(startWorktreeBaseDirectoryPoller).toHaveBeenCalledTimes(3))
  })

  it('bounds repeated subscription failures', async () => {
    const repo = makeRepo()
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' })
    vi.mocked(stat).mockImplementation(async (path) => {
      if (String(path).endsWith('.git')) {
        throw missing
      }
      return { isDirectory: () => true } as never
    })
    vi.mocked(startWorktreeBaseDirectoryPoller).mockRejectedValue(new Error('watch denied'))
    await syncWorktreeBaseDirectoryWatchers(makeStore([repo]) as never, makeWindow() as never)
    expect(startWorktreeBaseDirectoryPoller).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(250)
    await vi.waitFor(() => expect(startWorktreeBaseDirectoryPoller).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(startWorktreeBaseDirectoryPoller).toHaveBeenCalledTimes(3))
    await vi.advanceTimersByTimeAsync(4_000)
    await vi.waitFor(() => expect(startWorktreeBaseDirectoryPoller).toHaveBeenCalledTimes(4))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(startWorktreeBaseDirectoryPoller).toHaveBeenCalledTimes(4)
  })

  it('cancels subscription retries after target deletion and disposal', async () => {
    const repos = [makeRepo()]
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' })
    vi.mocked(stat).mockImplementation(async (path) => {
      if (String(path).endsWith('.git')) {
        throw missing
      }
      return { isDirectory: () => true } as never
    })
    vi.mocked(startWorktreeBaseDirectoryPoller).mockRejectedValue(new Error('watch denied'))
    const store = makeStore(repos)
    await syncWorktreeBaseDirectoryWatchers(store as never, makeWindow() as never)
    repos.splice(0, 1)
    await syncWorktreeBaseDirectoryWatchers(store as never, makeWindow() as never, {
      dirtyRepoIdentities: [{ repoId: 'repo-1', hostId: 'local' }]
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(startWorktreeBaseDirectoryPoller).toHaveBeenCalledOnce()

    repos.push(makeRepo({ id: 'repo-dispose' }))
    await syncWorktreeBaseDirectoryWatchers(store as never, makeWindow() as never, {
      dirtyRepoIdentities: [{ repoId: 'repo-dispose', hostId: 'local' }]
    })
    expect(startWorktreeBaseDirectoryPoller).toHaveBeenCalledTimes(2)
    await disposeWorktreeBaseDirectoryWatchers()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(startWorktreeBaseDirectoryPoller).toHaveBeenCalledTimes(2)
  })

  it('cancels stale provider-generation retries', async () => {
    const repo = makeRepo({ connectionId: 'ssh-a', path: '/srv/a/project' })
    const store = makeStore([repo])
    const failingProvider = makeRemoteFilesystemProvider()
    failingProvider.watch.mockRejectedValue(new Error('watch unavailable'))
    vi.mocked(getSshFilesystemProvider).mockReturnValue(failingProvider as never)
    await syncWorktreeBaseDirectoryWatchers(store as never, makeWindow() as never)

    const currentProvider = makeRemoteFilesystemProvider()
    providerGenerations.set('ssh-a', 1)
    vi.mocked(getSshFilesystemProvider).mockReturnValue(currentProvider as never)
    await syncWorktreeBaseDirectoryWatchers(store as never, makeWindow() as never, {
      dirtyConnectionIds: ['ssh-a']
    })
    expect(currentProvider.watch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(currentProvider.watch).toHaveBeenCalledTimes(2)
  })

  it('merges an aborted first invalidation into one non-overlapping trailing pass', async () => {
    const repos = makeRepoFleet()
    const store = makeStore(repos)
    useFleetProviders()
    await syncWorktreeBaseDirectoryWatchers(store as never, makeWindow() as never)
    const firstProbeGate = Promise.withResolvers<void>()
    let activeProbes = 0
    let maxActiveProbes = 0
    let deferFirstProbe = true
    vi.mocked(stat).mockClear()
    vi.mocked(stat).mockImplementation(async () => {
      activeProbes++
      maxActiveProbes = Math.max(maxActiveProbes, activeProbes)
      if (deferFirstProbe) {
        deferFirstProbe = false
        await firstProbeGate.promise
      }
      activeProbes--
      return { isDirectory: () => true } as never
    })

    repos[0] = { ...repos[0], path: absolutePath('workspace', 'projects', 'repo-0-v1') }
    const first = syncWorktreeBaseDirectoryWatchers(store as never, makeWindow() as never, {
      dirtyRepoIdentities: [{ repoId: 'repo-0', hostId: 'local' }]
    })
    await vi.waitFor(() => expect(stat).toHaveBeenCalledOnce())
    repos[1] = { ...repos[1], path: absolutePath('workspace', 'projects', 'repo-1-v2') }
    const second = syncWorktreeBaseDirectoryWatchers(store as never, makeWindow() as never, {
      dirtyRepoIdentities: [{ repoId: 'repo-1', hostId: 'local' }]
    })
    repos[2] = { ...repos[2], path: absolutePath('workspace', 'projects', 'repo-2-v3') }
    const third = syncWorktreeBaseDirectoryWatchers(store as never, makeWindow() as never, {
      dirtyRepoIdentities: [{ repoId: 'repo-2', hostId: 'local' }]
    })
    firstProbeGate.resolve()
    await Promise.all([first, second, third])

    expect(stat).toHaveBeenCalledTimes(7)
    expect(maxActiveProbes).toBe(1)
  })

  it('carries the active invalidation into a scheduled trailing pass', async () => {
    const repos = makeRepoFleet()
    const store = makeStore(repos)
    const mainWindow = makeWindow()
    useFleetProviders()
    await syncWorktreeBaseDirectoryWatchers(store as never, mainWindow as never)
    const firstProbeGate = Promise.withResolvers<void>()
    let deferFirstProbe = true
    vi.mocked(stat).mockClear()
    vi.mocked(stat).mockImplementation(async () => {
      if (deferFirstProbe) {
        deferFirstProbe = false
        await firstProbeGate.promise
      }
      return { isDirectory: () => true } as never
    })

    repos[0] = { ...repos[0], path: absolutePath('workspace', 'projects', 'repo-0-active') }
    const active = syncWorktreeBaseDirectoryWatchers(store as never, mainWindow as never, {
      dirtyRepoIdentities: [{ repoId: 'repo-0', hostId: 'local' }]
    })
    await vi.waitFor(() => expect(stat).toHaveBeenCalledOnce())
    repos[1] = { ...repos[1], path: absolutePath('workspace', 'projects', 'repo-1-scheduled') }
    scheduleWorktreeBaseDirectoryWatcherSync(store as never, mainWindow as never, {
      dirtyRepoIdentities: [{ repoId: 'repo-1', hostId: 'local' }]
    })
    firstProbeGate.resolve()
    await active
    await vi.advanceTimersByTimeAsync(100)
    await vi.waitFor(() => expect(stat).toHaveBeenCalledTimes(5))
  })

  it('cancels retry timers before waiting for a blocked synchronization to drain', async () => {
    const repo = makeRepo()
    const store = makeStore([repo])
    const mainWindow = makeWindow()
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' })
    vi.mocked(stat).mockImplementation(async (path) => {
      if (String(path).endsWith('.git')) {
        throw missing
      }
      return { isDirectory: () => true } as never
    })
    const blockedInstall = Promise.withResolvers<{ unsubscribe: () => Promise<void> }>()
    vi.mocked(startWorktreeBaseDirectoryPoller)
      .mockRejectedValueOnce(new Error('initial watch unavailable'))
      .mockImplementationOnce(async () => blockedInstall.promise)

    await syncWorktreeBaseDirectoryWatchers(store as never, mainWindow as never)
    const blockedSync = syncWorktreeBaseDirectoryWatchers(store as never, mainWindow as never, {
      dirtyRepoIdentities: [{ repoId: repo.id, hostId: 'local' }]
    })
    await vi.waitFor(() => expect(startWorktreeBaseDirectoryPoller).toHaveBeenCalledTimes(2))

    const disposal = disposeWorktreeBaseDirectoryWatchers()
    await vi.advanceTimersByTimeAsync(250)
    expect(startWorktreeBaseDirectoryPoller).toHaveBeenCalledTimes(2)
    blockedInstall.resolve({ unsubscribe: vi.fn(async () => {}) })
    await Promise.all([blockedSync, disposal])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(startWorktreeBaseDirectoryPoller).toHaveBeenCalledTimes(2)
  })

  it('cannot reinstall a stale path after its subscription completes', async () => {
    const repo = makeRepo()
    const store = makeStore([repo])
    const mainWindow = makeWindow()
    await syncWorktreeBaseDirectoryWatchers(store as never, mainWindow as never)
    vi.mocked(startWorktreeBaseDirectoryPoller).mockClear()
    const staleRoot = absolutePath('workspace', 'stale-worktrees')
    const currentRoot = absolutePath('workspace', 'current-worktrees')
    const staleUnsubscribe = vi.fn(async () => {})
    const staleInstall = Promise.withResolvers<{ unsubscribe: () => Promise<void> }>()
    vi.mocked(startWorktreeBaseDirectoryPoller).mockImplementationOnce(
      async () => staleInstall.promise
    )

    repo.worktreeBasePath = staleRoot
    const staleSync = syncWorktreeBaseDirectoryWatchers(store as never, mainWindow as never, {
      dirtyRepoIdentities: [{ repoId: repo.id, hostId: 'local' }]
    })
    await vi.waitFor(() =>
      expect(startWorktreeBaseDirectoryPoller).toHaveBeenCalledWith(
        expect.objectContaining({ path: staleRoot }),
        expect.any(Function),
        expect.any(Function),
        expect.any(Object)
      )
    )
    repo.worktreeBasePath = currentRoot
    const currentSync = syncWorktreeBaseDirectoryWatchers(store as never, mainWindow as never, {
      dirtyRepoIdentities: [{ repoId: repo.id, hostId: 'local' }]
    })
    staleInstall.resolve({ unsubscribe: staleUnsubscribe })
    await Promise.all([staleSync, currentSync])

    expect(staleUnsubscribe).toHaveBeenCalledOnce()
    expect(pollerRepoGetters.has(staleRoot)).toBe(false)
    expect(pollerRepoGetters.has(currentRoot)).toBe(true)
  })
})
