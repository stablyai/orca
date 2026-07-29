import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join, sep } from 'node:path'
import type { GlobalSettings, Repo } from '../../shared/types'
import type { WorktreeBasePollEvent } from './worktree-base-directory-poller'

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
  getSshFilesystemProvider: vi.fn()
}))

vi.mock('./worktree-head-identity-reader', () => ({
  readGitCommonHeadIdentities: vi.fn(async () => [])
}))

import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import {
  notifyWorktreeGitStatusMetadataChanged,
  notifyWorktreeHeadIdentitiesChanged,
  notifyWorktreesChanged
} from './worktree-remote'
import { readGitCommonHeadIdentities } from './worktree-head-identity-reader'
import { startWorktreeBaseDirectoryPoller } from './worktree-base-directory-poller'
import {
  disposeWorktreeBaseDirectoryWatchers,
  syncWorktreeBaseDirectoryWatchers
} from './worktree-base-directory-watcher'
import { matchingWorktreeBaseRepoIds } from './worktree-base-directory-event-filter'

type PollerCallback = (events: WorktreeBasePollEvent[]) => void

const watcherCallbacks = new Map<string, PollerCallback>()
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

function emit(root: string, events: WorktreeBasePollEvent[]): void {
  const callback = watcherCallbacks.get(root)
  if (!callback) {
    throw new Error(`No poller callback for ${root}`)
  }
  callback(events)
}

describe('worktree base directory watcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    watcherCallbacks.clear()
    unsubscribeMocks.clear()
    vi.mocked(getSshFilesystemProvider).mockReturnValue(undefined)
    vi.mocked(readGitCommonHeadIdentities).mockResolvedValue([])
    vi.mocked(startWorktreeBaseDirectoryPoller).mockImplementation(
      async (target, _getRepos, onEvents) => {
        const unsubscribe = vi.fn(async () => {})
        watcherCallbacks.set(target.path, onEvents)
        unsubscribeMocks.set(target.path, unsubscribe)
        return { unsubscribe }
      }
    )
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
      {
        type: 'create',
        path: join(WORKTREE_ROOT, 'project', 'external-5104', '.git')
      }
    ])

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
      {
        type: 'create',
        path: join(WORKTREE_ROOT, 'project', 'external-5104', '.git')
      }
    ])
    destroyed = true
    await vi.advanceTimersByTimeAsync(300)

    expect(notifyWorktreesChanged).not.toHaveBeenCalled()
  })

  it('ignores deep checkout churn below candidate roots', async () => {
    await syncWorktreeBaseDirectoryWatchers(makeStore([makeRepo()]) as never, makeWindow() as never)

    emit(WORKTREE_ROOT, [
      {
        type: 'update',
        path: join(WORKTREE_ROOT, 'project', 'existing', 'src', 'file.ts')
      }
    ])
    await vi.advanceTimersByTimeAsync(300)

    expect(notifyWorktreesChanged).not.toHaveBeenCalled()
  })

  it('uses Git common-dir worktree metadata as a low-churn completion signal', async () => {
    await syncWorktreeBaseDirectoryWatchers(makeStore([makeRepo()]) as never, makeWindow() as never)

    emit(PROJECT_GIT_COMMON_DIR, [
      {
        type: 'create',
        path: join(PROJECT_GIT_COMMON_DIR, 'worktrees', 'external-5104', 'gitdir')
      }
    ])
    await vi.advanceTimersByTimeAsync(300)

    expect(notifyWorktreesChanged).toHaveBeenCalledWith(expect.anything(), 'repo-1')
  })

  it('debounces linked index bursts as status-only without structural notification', async () => {
    await syncWorktreeBaseDirectoryWatchers(makeStore([makeRepo()]) as never, makeWindow() as never)

    emit(PROJECT_GIT_COMMON_DIR, [
      {
        type: 'create',
        path: join(PROJECT_GIT_COMMON_DIR, 'worktrees', 'external-5104', 'index')
      },
      {
        type: 'update',
        path: join(PROJECT_GIT_COMMON_DIR, 'worktrees', 'external-5104', 'index')
      },
      {
        type: 'delete',
        path: join(PROJECT_GIT_COMMON_DIR, 'worktrees', 'external-5104', 'index')
      }
    ])
    await vi.advanceTimersByTimeAsync(300)

    expect(notifyWorktreesChanged).not.toHaveBeenCalled()
    expect(notifyWorktreeGitStatusMetadataChanged).toHaveBeenCalledTimes(1)
    expect(notifyWorktreeGitStatusMetadataChanged).toHaveBeenCalledWith(expect.anything(), 'repo-1')
  })

  it('keeps linked HEAD and lock metadata structural', async () => {
    await syncWorktreeBaseDirectoryWatchers(makeStore([makeRepo()]) as never, makeWindow() as never)

    emit(PROJECT_GIT_COMMON_DIR, [
      {
        type: 'update',
        path: join(PROJECT_GIT_COMMON_DIR, 'worktrees', 'external-5104', 'HEAD')
      },
      {
        type: 'create',
        path: join(PROJECT_GIT_COMMON_DIR, 'worktrees', 'external-5104', 'locked')
      }
    ])
    await vi.advanceTimersByTimeAsync(300)

    expect(notifyWorktreesChanged).toHaveBeenCalledTimes(1)
    expect(notifyWorktreesChanged).toHaveBeenCalledWith(expect.anything(), 'repo-1')
    expect(notifyWorktreeGitStatusMetadataChanged).not.toHaveBeenCalled()
  })

  it('emits head identities for a linked reflog head move without structural fanout', async () => {
    const linkedWorktree = absolutePath('workspace', 'worktrees', 'project', 'external-5104')
    vi.mocked(readGitCommonHeadIdentities).mockResolvedValue([
      {
        worktreePath: linkedWorktree,
        head: 'aaa111',
        branch: 'refs/heads/feature'
      }
    ])
    await syncWorktreeBaseDirectoryWatchers(makeStore([makeRepo()]) as never, makeWindow() as never)
    await vi.advanceTimersByTimeAsync(0)

    // External commit --amend: only logs/HEAD moves, no index write.
    vi.mocked(readGitCommonHeadIdentities).mockResolvedValue([
      {
        worktreePath: linkedWorktree,
        head: 'bbb222',
        branch: 'refs/heads/feature'
      }
    ])
    emit(PROJECT_GIT_COMMON_DIR, [
      {
        type: 'update',
        path: join(PROJECT_GIT_COMMON_DIR, 'worktrees', 'external-5104', 'logs', 'HEAD')
      }
    ])
    await vi.advanceTimersByTimeAsync(300)
    await vi.advanceTimersByTimeAsync(0)

    expect(notifyWorktreesChanged).not.toHaveBeenCalled()
    expect(notifyWorktreeGitStatusMetadataChanged).toHaveBeenCalledTimes(1)
    expect(notifyWorktreeHeadIdentitiesChanged).toHaveBeenCalledTimes(1)
    expect(notifyWorktreeHeadIdentitiesChanged).toHaveBeenCalledWith(expect.anything(), 'repo-1', [
      {
        worktreePath: linkedWorktree,
        head: 'bbb222',
        branch: 'refs/heads/feature'
      }
    ])
  })

  it('makes zero head-identity reads on an index-only burst across linked and primary checkouts', async () => {
    const linkedWorktree = absolutePath('workspace', 'worktrees', 'project', 'external-5104')
    vi.mocked(readGitCommonHeadIdentities).mockResolvedValue([
      {
        worktreePath: linkedWorktree,
        head: 'aaa111',
        branch: 'refs/heads/feature'
      }
    ])
    await syncWorktreeBaseDirectoryWatchers(makeStore([makeRepo()]) as never, makeWindow() as never)
    await vi.advanceTimersByTimeAsync(0)
    // Subscribe baselines heads once; the index burst must add no further reads.
    vi.mocked(readGitCommonHeadIdentities).mockClear()

    emit(PROJECT_GIT_COMMON_DIR, [
      {
        type: 'create',
        path: join(PROJECT_GIT_COMMON_DIR, 'worktrees', 'external-5104', 'index')
      },
      {
        type: 'update',
        path: join(PROJECT_GIT_COMMON_DIR, 'worktrees', 'external-5104', 'index')
      },
      { type: 'update', path: join(PROJECT_GIT_COMMON_DIR, 'index') }
    ])
    await vi.advanceTimersByTimeAsync(300)
    await vi.advanceTimersByTimeAsync(0)

    // An index rewrite cannot move HEAD, so the linked-worktree scan is skipped.
    expect(readGitCommonHeadIdentities).not.toHaveBeenCalled()
    expect(notifyWorktreeHeadIdentitiesChanged).not.toHaveBeenCalled()
    // Source Control still refreshes for the status churn, coalesced to one call.
    expect(notifyWorktreeGitStatusMetadataChanged).toHaveBeenCalledTimes(1)
    expect(notifyWorktreesChanged).not.toHaveBeenCalled()
  })

  it('emits head identities for a primary-checkout reflog head move', async () => {
    vi.mocked(readGitCommonHeadIdentities).mockResolvedValue([
      { worktreePath: PROJECT_ROOT, head: 'aaa111', branch: 'refs/heads/main' }
    ])
    await syncWorktreeBaseDirectoryWatchers(makeStore([makeRepo()]) as never, makeWindow() as never)
    await vi.advanceTimersByTimeAsync(0)

    vi.mocked(readGitCommonHeadIdentities).mockResolvedValue([
      { worktreePath: PROJECT_ROOT, head: 'bbb222', branch: 'refs/heads/main' }
    ])
    emit(PROJECT_GIT_COMMON_DIR, [
      { type: 'update', path: join(PROJECT_GIT_COMMON_DIR, 'logs', 'HEAD') }
    ])
    await vi.advanceTimersByTimeAsync(300)
    await vi.advanceTimersByTimeAsync(0)

    expect(notifyWorktreesChanged).not.toHaveBeenCalled()
    expect(notifyWorktreeHeadIdentitiesChanged).toHaveBeenCalledWith(expect.anything(), 'repo-1', [
      {
        worktreePath: PROJECT_ROOT,
        head: 'bbb222',
        branch: 'refs/heads/main'
      }
    ])
  })

  it('coalesces an index and reflog burst into one head read and one status refresh', async () => {
    const linkedWorktree = absolutePath('workspace', 'worktrees', 'project', 'external-5104')
    vi.mocked(readGitCommonHeadIdentities).mockResolvedValue([
      {
        worktreePath: linkedWorktree,
        head: 'aaa111',
        branch: 'refs/heads/feature'
      }
    ])
    await syncWorktreeBaseDirectoryWatchers(makeStore([makeRepo()]) as never, makeWindow() as never)
    await vi.advanceTimersByTimeAsync(0)
    vi.mocked(readGitCommonHeadIdentities).mockClear()

    // reset --soft rewrites the index and appends logs/HEAD in the same burst.
    vi.mocked(readGitCommonHeadIdentities).mockResolvedValue([
      {
        worktreePath: linkedWorktree,
        head: 'bbb222',
        branch: 'refs/heads/feature'
      }
    ])
    emit(PROJECT_GIT_COMMON_DIR, [
      {
        type: 'update',
        path: join(PROJECT_GIT_COMMON_DIR, 'worktrees', 'external-5104', 'index')
      },
      {
        type: 'update',
        path: join(PROJECT_GIT_COMMON_DIR, 'worktrees', 'external-5104', 'logs', 'HEAD')
      }
    ])
    await vi.advanceTimersByTimeAsync(300)
    await vi.advanceTimersByTimeAsync(0)

    expect(readGitCommonHeadIdentities).toHaveBeenCalledTimes(1)
    expect(notifyWorktreeGitStatusMetadataChanged).toHaveBeenCalledTimes(1)
    expect(notifyWorktreeHeadIdentitiesChanged).toHaveBeenCalledTimes(1)
    expect(notifyWorktreesChanged).not.toHaveBeenCalled()
  })

  it('debounces successive reflog events into a single head read', async () => {
    const linkedWorktree = absolutePath('workspace', 'worktrees', 'project', 'external-5104')
    vi.mocked(readGitCommonHeadIdentities).mockResolvedValue([
      {
        worktreePath: linkedWorktree,
        head: 'aaa111',
        branch: 'refs/heads/feature'
      }
    ])
    await syncWorktreeBaseDirectoryWatchers(makeStore([makeRepo()]) as never, makeWindow() as never)
    await vi.advanceTimersByTimeAsync(0)
    vi.mocked(readGitCommonHeadIdentities).mockClear()

    const reflog = {
      type: 'update' as const,
      path: join(PROJECT_GIT_COMMON_DIR, 'worktrees', 'external-5104', 'logs', 'HEAD')
    }
    emit(PROJECT_GIT_COMMON_DIR, [reflog])
    // Second burst arrives before the debounce window elapses and resets it.
    await vi.advanceTimersByTimeAsync(100)
    emit(PROJECT_GIT_COMMON_DIR, [reflog])
    await vi.advanceTimersByTimeAsync(300)
    await vi.advanceTimersByTimeAsync(0)

    expect(readGitCommonHeadIdentities).toHaveBeenCalledTimes(1)
    expect(notifyWorktreeGitStatusMetadataChanged).toHaveBeenCalledTimes(1)
  })

  it('re-baselines head identities silently on structural notifications', async () => {
    const linkedWorktree = absolutePath('workspace', 'worktrees', 'project', 'external-5104')
    vi.mocked(readGitCommonHeadIdentities).mockResolvedValue([
      {
        worktreePath: linkedWorktree,
        head: 'aaa111',
        branch: 'refs/heads/feature'
      }
    ])
    await syncWorktreeBaseDirectoryWatchers(makeStore([makeRepo()]) as never, makeWindow() as never)
    await vi.advanceTimersByTimeAsync(0)

    // Branch switch: structural path owns the refresh via the full listing.
    vi.mocked(readGitCommonHeadIdentities).mockResolvedValue([
      {
        worktreePath: linkedWorktree,
        head: 'ccc333',
        branch: 'refs/heads/other'
      }
    ])
    emit(PROJECT_GIT_COMMON_DIR, [
      {
        type: 'update',
        path: join(PROJECT_GIT_COMMON_DIR, 'worktrees', 'external-5104', 'HEAD')
      }
    ])
    await vi.advanceTimersByTimeAsync(300)
    await vi.advanceTimersByTimeAsync(0)
    expect(notifyWorktreeHeadIdentitiesChanged).not.toHaveBeenCalled()

    // A later reflog event diffs against the re-baselined heads, so an
    // unchanged head is not re-reported.
    emit(PROJECT_GIT_COMMON_DIR, [
      {
        type: 'update',
        path: join(PROJECT_GIT_COMMON_DIR, 'worktrees', 'external-5104', 'logs', 'HEAD')
      }
    ])
    await vi.advanceTimersByTimeAsync(300)
    await vi.advanceTimersByTimeAsync(0)
    expect(notifyWorktreeHeadIdentitiesChanged).not.toHaveBeenCalled()
  })

  it('never reads head identities for SSH watches', async () => {
    const remoteCallbacks = new Map<string, (events: never[]) => void>()
    const remoteWatch = vi.fn(async (root: string, callback: (events: never[]) => void) => {
      remoteCallbacks.set(root, callback)
      return vi.fn()
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
    remoteCallbacks.get('/home/alice/project/.git')?.([
      {
        kind: 'update',
        absolutePath: '/home/alice/project/.git/worktrees/wt/logs/HEAD'
      }
    ] as never[])
    await vi.advanceTimersByTimeAsync(300)

    expect(notifyWorktreeGitStatusMetadataChanged).toHaveBeenCalledTimes(1)
    expect(readGitCommonHeadIdentities).not.toHaveBeenCalled()
    expect(notifyWorktreeHeadIdentitiesChanged).not.toHaveBeenCalled()
  })

  it('does not install local desktop watchers for runtime or folder repos', async () => {
    await syncWorktreeBaseDirectoryWatchers(
      makeStore([
        makeRepo({ id: 'runtime', executionHostId: 'runtime:dev' }),
        makeRepo({ id: 'folder', kind: 'folder' })
      ]) as never,
      makeWindow() as never
    )

    expect(startWorktreeBaseDirectoryPoller).not.toHaveBeenCalled()
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

    expect(startWorktreeBaseDirectoryPoller).not.toHaveBeenCalled()
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

  it('treats remote index renames as status-only and overflow as structural', async () => {
    const remoteCallbacks = new Map<string, (events: never[]) => void>()
    const remoteWatch = vi.fn(async (root: string, callback: (events: never[]) => void) => {
      remoteCallbacks.set(root, callback)
      return vi.fn()
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

    remoteCallbacks.get('/home/alice/project/.git')?.([
      {
        kind: 'rename',
        oldAbsolutePath: '/home/alice/project/.git/worktrees/wt/index.lock',
        absolutePath: '/home/alice/project/.git/worktrees/wt/index'
      }
    ] as never[])
    await vi.advanceTimersByTimeAsync(300)
    expect(notifyWorktreesChanged).not.toHaveBeenCalled()
    expect(notifyWorktreeGitStatusMetadataChanged).toHaveBeenCalledTimes(1)

    vi.mocked(notifyWorktreeGitStatusMetadataChanged).mockClear()
    remoteCallbacks.get('/home/alice/project/.git')?.([{ kind: 'overflow' }] as never[])
    await vi.advanceTimersByTimeAsync(300)
    expect(notifyWorktreesChanged).toHaveBeenCalledWith(expect.anything(), 'repo-1')
    expect(notifyWorktreeGitStatusMetadataChanged).not.toHaveBeenCalled()
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
    let resolveInstall: (subscription: { unsubscribe: () => Promise<void> }) => void = () => {}
    const unsubscribe = vi.fn(async () => {})
    vi.mocked(startWorktreeBaseDirectoryPoller).mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          resolveInstall = resolve
        })
    )

    const syncPromise = syncWorktreeBaseDirectoryWatchers(
      makeStore([makeRepo()]) as never,
      makeWindow() as never
    )
    await vi.waitFor(() => expect(startWorktreeBaseDirectoryPoller).toHaveBeenCalled())
    const disposePromise = disposeWorktreeBaseDirectoryWatchers()
    resolveInstall({ unsubscribe })
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
      })
    ).toEqual(['repo-1'])
    expect(
      matchingWorktreeBaseRepoIds(target, {
        type: 'update',
        path: join(WORKTREE_ROOT, 'external-5104', 'src', 'file.ts')
      })
    ).toEqual([])
  })
})
