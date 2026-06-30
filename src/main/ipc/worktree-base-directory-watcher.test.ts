import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join, sep } from 'node:path'
import type { Event as WatcherEvent, SubscribeCallback } from '@parcel/watcher'
import type { GlobalSettings, Repo } from '../../shared/types'

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async () => ''),
  realpath: vi.fn(async (path: string) => path),
  stat: vi.fn(async () => ({ isDirectory: () => true }))
}))

vi.mock('@parcel/watcher', () => ({
  subscribe: vi.fn()
}))

vi.mock('./worktree-remote', () => ({
  notifyWorktreesChanged: vi.fn()
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: vi.fn()
}))

import { subscribe } from '@parcel/watcher'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { notifyWorktreesChanged } from './worktree-remote'
import {
  disposeWorktreeBaseDirectoryWatchers,
  syncWorktreeBaseDirectoryWatchers
} from './worktree-base-directory-watcher'
import { matchingWorktreeBaseRepoIds } from './worktree-base-directory-event-filter'

type WatcherCallback = SubscribeCallback

const watcherCallbacks = new Map<string, WatcherCallback>()
const unsubscribeMocks = new Map<string, ReturnType<typeof vi.fn>>()
const absolutePath = (...parts: string[]): string => join(sep, ...parts)
const WORKTREE_ROOT = absolutePath('workspace', 'worktrees')
const PROJECT_ROOT = absolutePath('workspace', 'projects', 'project')
const PROJECT_GIT_COMMON_DIR = join(PROJECT_ROOT, '.git')

const settings = {
  workspaceDir: WORKTREE_ROOT,
  nestWorkspaces: true
} as GlobalSettings

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: PROJECT_ROOT,
    displayName: 'Project',
    badgeColor: '#000000',
    addedAt: 1,
    ...overrides
  } as Repo
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

function emit(root: string, events: WatcherEvent[]): void {
  const callback = watcherCallbacks.get(root)
  if (!callback) {
    throw new Error(`No watcher callback for ${root}`)
  }
  callback(null, events)
}

describe('worktree base directory watcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    watcherCallbacks.clear()
    unsubscribeMocks.clear()
    vi.mocked(getSshFilesystemProvider).mockReturnValue(undefined)
    vi.mocked(subscribe).mockImplementation(async (root, callback) => {
      const unsubscribe = vi.fn(async () => {})
      watcherCallbacks.set(root, callback)
      unsubscribeMocks.set(root, unsubscribe)
      return { unsubscribe }
    })
  })

  afterEach(async () => {
    await disposeWorktreeBaseDirectoryWatchers()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('coalesces nested worktree completion events into one targeted notification', async () => {
    await syncWorktreeBaseDirectoryWatchers(makeStore([makeRepo()]) as never, makeWindow() as never)

    emit(WORKTREE_ROOT, [
      { type: 'create', path: join(WORKTREE_ROOT, 'project', 'external-5104') },
      { type: 'create', path: join(WORKTREE_ROOT, 'project', 'external-5104', '.git') }
    ] as WatcherEvent[])

    await vi.advanceTimersByTimeAsync(300)

    expect(notifyWorktreesChanged).toHaveBeenCalledTimes(1)
    expect(notifyWorktreesChanged).toHaveBeenCalledWith(expect.anything(), 'repo-1')
  })

  it('drops pending worktree notifications after the window is destroyed', async () => {
    let destroyed = false
    await syncWorktreeBaseDirectoryWatchers(
      makeStore([makeRepo()]) as never,
      makeWindow({ destroyed: () => destroyed }) as never
    )

    emit(WORKTREE_ROOT, [
      { type: 'create', path: join(WORKTREE_ROOT, 'project', 'external-5104', '.git') }
    ] as WatcherEvent[])
    destroyed = true
    await vi.advanceTimersByTimeAsync(300)

    expect(notifyWorktreesChanged).not.toHaveBeenCalled()
  })

  it('ignores deep checkout churn below candidate roots', async () => {
    await syncWorktreeBaseDirectoryWatchers(makeStore([makeRepo()]) as never, makeWindow() as never)

    emit(WORKTREE_ROOT, [
      { type: 'update', path: join(WORKTREE_ROOT, 'project', 'existing', 'src', 'file.ts') }
    ] as WatcherEvent[])
    await vi.advanceTimersByTimeAsync(300)

    expect(notifyWorktreesChanged).not.toHaveBeenCalled()
  })

  it('uses Git common-dir worktree metadata as a low-churn completion signal', async () => {
    await syncWorktreeBaseDirectoryWatchers(makeStore([makeRepo()]) as never, makeWindow() as never)

    emit(PROJECT_GIT_COMMON_DIR, [
      { type: 'create', path: join(PROJECT_GIT_COMMON_DIR, 'worktrees', 'external-5104', 'gitdir') }
    ] as WatcherEvent[])
    await vi.advanceTimersByTimeAsync(300)

    expect(notifyWorktreesChanged).toHaveBeenCalledWith(expect.anything(), 'repo-1')
  })

  it('does not install local desktop watchers for runtime or folder repos', async () => {
    await syncWorktreeBaseDirectoryWatchers(
      makeStore([
        makeRepo({ id: 'runtime', executionHostId: 'runtime:dev' }),
        makeRepo({ id: 'folder', kind: 'folder' })
      ]) as never,
      makeWindow() as never
    )

    expect(subscribe).not.toHaveBeenCalled()
  })

  it('uses the remote sibling root for default SSH worktree roots', async () => {
    const remoteCallbacks = new Map<string, (events: never[]) => void>()
    const remoteUnwatch = vi.fn()
    const remoteWatch = vi.fn(async (root: string, callback: (events: never[]) => void) => {
      remoteCallbacks.set(root, callback)
      return remoteUnwatch
    })
    vi.mocked(getSshFilesystemProvider).mockReturnValue({
      stat: vi.fn(async () => ({ type: 'directory', size: 0, mtime: 0 })),
      realpath: vi.fn(async (path: string) => path),
      readFile: vi.fn(async () => ({ content: '', isBinary: false })),
      watch: remoteWatch
    } as never)

    await syncWorktreeBaseDirectoryWatchers(
      makeStore([makeRepo({ connectionId: 'ssh-1', path: '/home/alice/project' })]) as never,
      makeWindow() as never
    )

    expect(subscribe).not.toHaveBeenCalled()
    expect(remoteWatch).toHaveBeenCalledWith('/home/alice', expect.any(Function))
    remoteCallbacks.get('/home/alice')?.([
      {
        kind: 'create',
        absolutePath: '/home/alice/external-5104/.git'
      }
    ] as never[])
    await vi.advanceTimersByTimeAsync(300)

    expect(notifyWorktreesChanged).toHaveBeenCalledWith(expect.anything(), 'repo-1')
    await disposeWorktreeBaseDirectoryWatchers()
    expect(remoteUnwatch).toHaveBeenCalled()
  })

  it('unsubscribes roots that disappear after repo settings change', async () => {
    const repo = makeRepo()
    const store = makeStore([repo])
    await syncWorktreeBaseDirectoryWatchers(store as never, makeWindow() as never)

    const otherRoot = absolutePath('workspace', 'other-worktrees')
    repo.worktreeBasePath = otherRoot
    await syncWorktreeBaseDirectoryWatchers(store as never, makeWindow() as never)

    expect(unsubscribeMocks.get(WORKTREE_ROOT)).toHaveBeenCalled()
    expect(watcherCallbacks.has(otherRoot)).toBe(true)
  })

  it('unsubscribes a watcher that finishes installing after disposal starts', async () => {
    let resolveSubscribe: (subscription: { unsubscribe: () => Promise<void> }) => void = () => {}
    const unsubscribe = vi.fn(async () => {})
    vi.mocked(subscribe).mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          resolveSubscribe = resolve
        })
    )

    const syncPromise = syncWorktreeBaseDirectoryWatchers(
      makeStore([makeRepo()]) as never,
      makeWindow() as never
    )
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalled())
    const disposePromise = disposeWorktreeBaseDirectoryWatchers()
    resolveSubscribe({ unsubscribe })
    await syncPromise
    await disposePromise

    expect(unsubscribe).toHaveBeenCalled()
  })

  it('matches flat workspace .git marker events without matching sibling churn', () => {
    const target = {
      key: `base:${WORKTREE_ROOT}`,
      kind: 'base' as const,
      path: WORKTREE_ROOT,
      repos: new Map([['repo-1', { repoId: 'repo-1', repoName: 'project', nestWorkspaces: false }]])
    }

    expect(
      matchingWorktreeBaseRepoIds(target, {
        type: 'create',
        path: join(WORKTREE_ROOT, 'external-5104', '.git')
      } as WatcherEvent)
    ).toEqual(['repo-1'])
    expect(
      matchingWorktreeBaseRepoIds(target, {
        type: 'update',
        path: join(WORKTREE_ROOT, 'external-5104', 'src', 'file.ts')
      } as WatcherEvent)
    ).toEqual([])
  })
})
