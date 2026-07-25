import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { subscribeViaWatcherProcess } from './parcel-watcher-process'
import type {
  WatcherProcessCallback,
  WatcherProcessHooks
} from './parcel-watcher-process-subscription'
import type { WorktreeBaseWatchTarget } from './worktree-base-directory-event-filter'
import type {
  WorktreeBasePollEvent,
  WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'
import { startGitCommonWatch } from './worktree-git-common-watch'

vi.mock('./parcel-watcher-process', () => ({
  subscribeViaWatcherProcess: vi.fn()
}))

const POLL_MS = 25

const alwaysVisible: WorktreePollerWindowVisibility = {
  isWindowVisible: () => true,
  onWindowBecameVisible: () => () => {}
}

function createVisibilityHarness(): {
  source: WorktreePollerWindowVisibility
  hide: () => void
  show: () => void
} {
  let visible = true
  let listener: (() => void) | null = null
  return {
    source: {
      isWindowVisible: () => visible,
      onWindowBecameVisible: (nextListener) => {
        listener = nextListener
        return () => {
          if (listener === nextListener) {
            listener = null
          }
        }
      }
    },
    hide: () => {
      visible = false
    },
    show: () => {
      visible = true
      listener?.()
    }
  }
}

type ChildSubscription = {
  dir: string
  callback: WatcherProcessCallback
  hooks: WatcherProcessHooks
  unsubscribe: ReturnType<typeof vi.fn>
}

describe('worktree git-common narrow watch (darwin)', () => {
  const cleanups: (() => Promise<void>)[] = []
  const subscribeMock = vi.mocked(subscribeViaWatcherProcess)
  let childSubscriptions: ChildSubscription[] = []

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
    childSubscriptions = []
    subscribeMock.mockReset()
  })

  function installSubscribeMock(): void {
    subscribeMock.mockImplementation(async (dir, callback, _opts, hooks = {}) => {
      const unsubscribe = vi.fn(async () => {})
      childSubscriptions.push({ dir, callback, hooks, unsubscribe })
      return { unsubscribe }
    })
  }

  async function makeCommonDir(withWorktrees: boolean): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'orca-git-common-watch-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const commonDir = await realpath(root)
    if (withWorktrees) {
      await mkdir(join(commonDir, 'worktrees'))
    }
    return commonDir
  }

  function makeTarget(path: string): WorktreeBaseWatchTarget {
    return {
      key: `git-common:local:${path}`,
      kind: 'git-common',
      path,
      repos: new Map([['repo-1', { repoId: 'repo-1', repoName: 'project', nestWorkspaces: false }]])
    }
  }

  async function startWatch(commonDir: string, received: WorktreeBasePollEvent[][]): Promise<void> {
    const watch = await startGitCommonWatch(
      makeTarget(commonDir),
      (events) => received.push(events),
      POLL_MS,
      'darwin',
      alwaysVisible
    )
    cleanups.push(() => watch.unsubscribe())
  }

  it('hosts the narrow stream in the watcher child, not in-process', async () => {
    installSubscribeMock()
    const commonDir = await makeCommonDir(true)
    const received: WorktreeBasePollEvent[][] = []
    await startWatch(commonDir, received)

    expect(subscribeMock).toHaveBeenCalledTimes(1)
    const [dir, , opts] = subscribeMock.mock.calls[0]
    expect(dir).toBe(join(commonDir, 'worktrees'))
    expect(opts).toEqual({})

    const entryPath = join(commonDir, 'worktrees', 'wt-a')
    childSubscriptions[0].callback(null, [{ type: 'create', path: entryPath }])
    expect(received.flat()).toContainEqual({ type: 'create', path: entryPath })
  })

  it('tears down and re-arms when the watched root is deleted', async () => {
    installSubscribeMock()
    const commonDir = await makeCommonDir(true)
    const worktreesDir = join(commonDir, 'worktrees')
    const received: WorktreeBasePollEvent[][] = []
    await startWatch(commonDir, received)

    await rm(worktreesDir, { recursive: true, force: true })
    childSubscriptions[0].callback(null, [{ type: 'delete', path: worktreesDir }])
    await vi.waitFor(() => {
      expect(childSubscriptions[0].unsubscribe).toHaveBeenCalledTimes(1)
    })
    expect(received.flat()).toContainEqual({ type: 'delete', path: worktreesDir })

    // The existence poll re-subscribes once a new first worktree recreates it.
    await mkdir(worktreesDir)
    await vi.waitFor(() => {
      expect(subscribeMock).toHaveBeenCalledTimes(2)
    })
    expect(received.flat()).toContainEqual({ type: 'create', path: worktreesDir })
  })

  it('tears down and re-arms on watcher errors', async () => {
    installSubscribeMock()
    const commonDir = await makeCommonDir(true)
    const worktreesDir = join(commonDir, 'worktrees')
    const received: WorktreeBasePollEvent[][] = []
    await startWatch(commonDir, received)

    childSubscriptions[0].callback(new Error('watcher child reported failure'), [])
    await vi.waitFor(() => {
      expect(childSubscriptions[0].unsubscribe).toHaveBeenCalledTimes(1)
    })
    // The error is surfaced as a structural change so worktrees re-sync.
    expect(received.flat()).toContainEqual({ type: 'update', path: worktreesDir })

    // The dir still exists, so the existence poll re-subscribes.
    await vi.waitFor(() => {
      expect(subscribeMock).toHaveBeenCalledTimes(2)
    })

    const receivedAfterRearm = received.length
    childSubscriptions[0].callback(new Error('late error from replaced watcher'), [])
    childSubscriptions[0].callback(null, [
      { type: 'create', path: join(worktreesDir, 'late-old-event') }
    ])
    childSubscriptions[0].hooks.onInterruption?.()

    // A replaced watch cannot tear down its successor or report stale events.
    expect(received).toHaveLength(receivedAfterRearm)
    expect(childSubscriptions[1].unsubscribe).not.toHaveBeenCalled()
  })

  it('reports a structural change after a watcher-child interruption', async () => {
    installSubscribeMock()
    const commonDir = await makeCommonDir(true)
    const worktreesDir = join(commonDir, 'worktrees')
    const received: WorktreeBasePollEvent[][] = []
    await startWatch(commonDir, received)

    childSubscriptions[0].hooks.onInterruption?.()
    expect(received.flat()).toContainEqual({ type: 'update', path: worktreesDir })
    // The supervisor resubscribed the same record; no teardown should happen.
    expect(childSubscriptions[0].unsubscribe).not.toHaveBeenCalled()
  })

  it('arms via existence polling when the worktrees dir appears later', async () => {
    installSubscribeMock()
    const commonDir = await makeCommonDir(false)
    const received: WorktreeBasePollEvent[][] = []
    await startWatch(commonDir, received)
    expect(subscribeMock).not.toHaveBeenCalled()

    await mkdir(join(commonDir, 'worktrees'))
    await vi.waitFor(() => {
      expect(subscribeMock).toHaveBeenCalledTimes(1)
    })
  })

  it('keeps the native stream live while the primary poll is parked', async () => {
    installSubscribeMock()
    const commonDir = await makeCommonDir(true)
    const headFile = join(commonDir, 'HEAD')
    await writeFile(headFile, 'ref: refs/heads/main')
    const visibility = createVisibilityHarness()
    const received: WorktreeBasePollEvent[][] = []
    const fullScans: number[] = []
    const watch = await startGitCommonWatch(
      makeTarget(commonDir),
      (events) => received.push(events),
      POLL_MS,
      'darwin',
      visibility.source,
      () => fullScans.push(Date.now())
    )
    cleanups.push(() => watch.unsubscribe())

    visibility.hide()
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 2))
    await writeFile(headFile, 'ref: refs/heads/feature')
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 2))

    expect(fullScans).toHaveLength(0)
    const entryPath = join(commonDir, 'worktrees', 'native-while-hidden')
    childSubscriptions[0].callback(null, [{ type: 'create', path: entryPath }])
    expect(received.flat()).toContainEqual({ type: 'create', path: entryPath })
    expect(childSubscriptions[0].unsubscribe).not.toHaveBeenCalled()

    visibility.show()
    expect(fullScans).toHaveLength(1)
    await vi.waitFor(() => {
      expect(received.flat()).toContainEqual({ type: 'update', path: headFile })
    })
  })

  it('stops forwarding events and unsubscribes the child on dispose', async () => {
    installSubscribeMock()
    const commonDir = await makeCommonDir(true)
    const received: WorktreeBasePollEvent[][] = []
    const watch = await startGitCommonWatch(
      makeTarget(commonDir),
      (events) => received.push(events),
      POLL_MS,
      'darwin',
      alwaysVisible
    )
    await watch.unsubscribe()
    expect(childSubscriptions[0].unsubscribe).toHaveBeenCalledTimes(1)

    received.length = 0
    childSubscriptions[0].callback(null, [
      { type: 'create', path: join(commonDir, 'worktrees', 'late') }
    ])
    expect(received).toHaveLength(0)
  })
})

describe('worktree git-common polling gate (non-darwin)', () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  })

  async function makePollingCommonDir(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'orca-git-common-polling-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const commonDir = await realpath(root)
    await mkdir(join(commonDir, 'worktrees'))
    return commonDir
  }

  function makePollingTarget(path: string): WorktreeBaseWatchTarget {
    return {
      key: `git-common:local:${path}`,
      kind: 'git-common',
      path,
      repos: new Map([['repo-1', { repoId: 'repo-1', repoName: 'project', nestWorkspaces: false }]])
    }
  }

  async function startPollingWatch(
    commonDir: string,
    received: WorktreeBasePollEvent[][],
    onFullScan?: () => void,
    visibility: WorktreePollerWindowVisibility = alwaysVisible
  ): Promise<void> {
    const watch = await startGitCommonWatch(
      makePollingTarget(commonDir),
      (events) => received.push(events),
      POLL_MS,
      'linux',
      visibility,
      onFullScan
    )
    cleanups.push(() => watch.unsubscribe())
  }

  it('skips the ungated index-metadata backstop on idle ticks', async () => {
    // Why: idle ticks still re-stat structural leaves and list the (small) worktrees dir cheaply, but the
    // heavier ungated per-entry index fan-out (onFullScan) must NOT run until the backstop — and no
    // spurious events are emitted while nothing changes.
    const commonDir = await makePollingCommonDir()
    const entry = join(commonDir, 'worktrees', 'idle')
    await mkdir(join(entry, 'logs'), { recursive: true })
    await writeFile(join(entry, 'HEAD'), 'ref: refs/heads/main')
    await writeFile(join(entry, 'logs', 'HEAD'), 'baseline\n')
    const received: WorktreeBasePollEvent[][] = []
    const fullScans = vi.fn()

    await startPollingWatch(commonDir, received, fullScans)
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 6))

    expect(fullScans).not.toHaveBeenCalled()
    expect(received.flat()).toHaveLength(0)
  })

  it('detects linked worktree add and remove from the every-tick readdir', async () => {
    // Why: the worktrees-dir listing runs every tick (not gated on its stat signature), so an add/remove
    // surfaces within one poll interval even on a coarse-mtime filesystem whose dir signature would not
    // move — without waiting on the index backstop (onFullScan).
    const commonDir = await makePollingCommonDir()
    const received: WorktreeBasePollEvent[][] = []
    const fullScans = vi.fn()
    await startPollingWatch(commonDir, received, fullScans)

    const entry = join(commonDir, 'worktrees', 'added')
    await mkdir(entry)
    await vi.waitFor(() => {
      expect(received.flat()).toContainEqual({ type: 'create', path: entry })
    })
    // The add is caught by the every-tick listing, NOT the 15-tick index backstop: detection lands well
    // before a backstop could fire, so onFullScan must not have run. (On the old gated impl a coarse-FS
    // signature collision would have deferred this to the backstop.)
    expect(fullScans).not.toHaveBeenCalled()

    await rm(entry, { recursive: true })
    await vi.waitFor(() => {
      expect(received.flat()).toContainEqual({ type: 'delete', path: entry })
    })
  })

  // Why runIf: chmod 0 cannot revoke directory listing on Windows or for root, so the EACCES injection is inert there.
  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'does not fabricate worktree deletions when the readdir fails non-ENOENT (transient)',
    async () => {
      // Why: a transient readdir failure (EIO/ESTALE/EMFILE/EACCES, network/SSH hiccup) must not be read
      // as "every linked worktree removed". Revoke dir permissions so readdir throws EACCES; the known
      // entry must NOT be reported deleted. On the old catch-all (entryPaths = []) this emitted a false
      // delete for every entry. chmod (not a dir->file swap) because it is one atomic syscall: an
      // in-flight tick's threadpool readdir sees success or EACCES, never a transient ENOENT window
      // that would legitimately emit a delete and flake this assertion.
      const commonDir = await makePollingCommonDir()
      const entry = join(commonDir, 'worktrees', 'keep')
      await mkdir(entry)
      await writeFile(join(entry, 'HEAD'), 'ref: refs/heads/main')
      const received: WorktreeBasePollEvent[][] = []
      await startPollingWatch(commonDir, received)

      await new Promise((resolve) => setTimeout(resolve, POLL_MS * 2))
      const worktreesDir = join(commonDir, 'worktrees')
      chmodSync(worktreesDir, 0o000)
      try {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4))
      } finally {
        // Why: restore before cleanup so the afterEach recursive rm can traverse the dir.
        chmodSync(worktreesDir, 0o755)
      }

      expect(received.flat()).not.toContainEqual({ type: 'delete', path: entry })
    }
  )

  it('detects an in-place structural (HEAD) write on a known entry every tick, without the index backstop', async () => {
    // Why: a raw HEAD/gitdir/config.worktree rewrite does not bump the entry-dir mtime, so the
    // structural leaves are re-stat'd every tick (never gated) — the change surfaces within one tick
    // and does NOT require the ungated index-metadata backstop (onFullScan).
    const commonDir = await makePollingCommonDir()
    const entry = join(commonDir, 'worktrees', 'structural')
    await mkdir(entry)
    await writeFile(join(entry, 'HEAD'), 'ref: refs/heads/main')
    const received: WorktreeBasePollEvent[][] = []
    const fullScans = vi.fn()
    await startPollingWatch(commonDir, received, fullScans)

    const headPath = join(entry, 'HEAD')
    // In-place rewrite: same file, different contents — no entry-dir mtime change.
    await writeFile(headPath, 'ref: refs/heads/feature')
    await vi.waitFor(() => {
      expect(received.flat()).toContainEqual({ type: 'update', path: headPath })
    })
    expect(fullScans).not.toHaveBeenCalled()
  })

  it('polls linked logs/HEAD on every idle tick', async () => {
    const commonDir = await makePollingCommonDir()
    const entry = join(commonDir, 'worktrees', 'reflog')
    await mkdir(join(entry, 'logs'), { recursive: true })
    const headLogPath = join(entry, 'logs', 'HEAD')
    await writeFile(headLogPath, 'baseline\n')
    const received: WorktreeBasePollEvent[][] = []
    const fullScans = vi.fn()
    await startPollingWatch(commonDir, received, fullScans)

    await appendFile(headLogPath, 'next\n')
    await vi.waitFor(() => {
      expect(received.flat()).toContainEqual({ type: 'update', path: headLogPath })
    })
    expect(fullScans).not.toHaveBeenCalled()
  })

  it('forces a full scan on the 15-tick backstop', async () => {
    const commonDir = await makePollingCommonDir()
    const entry = join(commonDir, 'worktrees', 'backstop')
    await mkdir(entry)
    await writeFile(join(entry, 'index'), 'baseline')
    const received: WorktreeBasePollEvent[][] = []
    const fullScans = vi.fn()
    await startPollingWatch(commonDir, received, fullScans)

    await vi.waitFor(() => {
      expect(fullScans).toHaveBeenCalledTimes(1)
    })
    expect(received.flat()).toHaveLength(0)
  })

  it('forces a full fan-out when resuming after hidden', async () => {
    const commonDir = await makePollingCommonDir()
    const entry = join(commonDir, 'worktrees', 'resume')
    await mkdir(entry)
    const indexPath = join(entry, 'index')
    await writeFile(indexPath, 'before')
    const received: WorktreeBasePollEvent[][] = []
    const fullScans = vi.fn()
    const visibility = createVisibilityHarness()
    await startPollingWatch(commonDir, received, fullScans, visibility.source)

    visibility.hide()
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 2))
    await writeFile(indexPath, 'after-longer')
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 2))
    expect(fullScans).not.toHaveBeenCalled()
    expect(received.flat()).toHaveLength(0)

    visibility.show()
    await vi.waitFor(() => {
      expect(received.flat()).toContainEqual({ type: 'update', path: indexPath })
    })
    expect(fullScans).toHaveBeenCalledTimes(1)
  })
})
