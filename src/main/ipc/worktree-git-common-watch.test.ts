import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
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

// Records every stat target so a test can assert which paths a parked poll stopped touching.
const { statCalls, transientStatFailures, readdirFailureCodes } = vi.hoisted(() => ({
  statCalls: [] as string[],
  transientStatFailures: new Map<string, number>(),
  readdirFailureCodes: new Map<string, string>()
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const path = String(args[0])
      statCalls.push(path)
      const remainingFailures = transientStatFailures.get(path) ?? 0
      if (remainingFailures > 0) {
        transientStatFailures.set(path, remainingFailures - 1)
        throw Object.assign(new Error('transient stat failure'), { code: 'EIO' })
      }
      return actual.stat(...args)
    },
    // Injected rather than staged on the real fs: swapping the dir for a file is two syscalls, so an
    // in-flight tick could observe the ENOENT window and legitimately emit the delete under test.
    readdir: async (path: string, options?: { withFileTypes?: boolean }) => {
      const failureCode = readdirFailureCodes.get(String(path))
      if (failureCode) {
        throw Object.assign(new Error(`injected ${failureCode}`), { code: failureCode })
      }
      return options?.withFileTypes === true
        ? actual.readdir(path, { withFileTypes: true })
        : actual.readdir(path)
    }
  }
})

const POLL_MS = 25
// Mirrors the production ratio in worktree-base-directory-poller.
const IDLE_POLL_MS = POLL_MS * 5
const BACKSTOP_MS = POLL_MS * 15

const alwaysVisible: WorktreePollerWindowVisibility = {
  isWindowVisible: () => true,
  onWindowBecameVisible: () => () => {}
}

function createVisibilityHarness(): {
  source: WorktreePollerWindowVisibility
  hide: () => void
  show: () => void
  listenerCount: () => number
} {
  let visible = true
  // A set, not a single slot: the darwin path parks two independent watches.
  const listeners = new Set<() => void>()
  return {
    source: {
      isWindowVisible: () => visible,
      onWindowBecameVisible: (nextListener) => {
        listeners.add(nextListener)
        return () => {
          listeners.delete(nextListener)
        }
      }
    },
    hide: () => {
      visible = false
    },
    show: () => {
      visible = true
      for (const listener of listeners) {
        listener()
      }
    },
    listenerCount: () => listeners.size
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
    statCalls.length = 0
    transientStatFailures.clear()
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
      alwaysVisible,
      undefined,
      IDLE_POLL_MS,
      BACKSTOP_MS
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

  it('installs the narrow stream and retries a transient primary baseline failure', async () => {
    installSubscribeMock()
    const commonDir = await makeCommonDir(true)
    const headPath = join(commonDir, 'HEAD')
    transientStatFailures.set(headPath, 1)
    const received: WorktreeBasePollEvent[][] = []
    await startWatch(commonDir, received)

    expect(subscribeMock).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => {
      expect(received.flat()).toContainEqual({ type: 'update', path: headPath })
    })
  })

  it('keeps reporting other primary files while one keeps failing to stat', async () => {
    installSubscribeMock()
    const commonDir = await makeCommonDir(true)
    const headPath = join(commonDir, 'HEAD')
    const packedRefsPath = join(commonDir, 'packed-refs')
    await writeFile(headPath, 'ref: refs/heads/main\n')
    await writeFile(packedRefsPath, '')
    const received: WorktreeBasePollEvent[][] = []
    await startWatch(commonDir, received)

    transientStatFailures.set(headPath, 1_000)
    // Only append once the failure is provably in effect, so the tick that sees it also lost HEAD.
    await vi.waitFor(() => expect(transientStatFailures.get(headPath)).toBeLessThan(1_000))
    await appendFile(packedRefsPath, 'deadbeef refs/heads/feature\n')

    await vi.waitFor(() => {
      expect(received.flat()).toContainEqual({ type: 'update', path: packedRefsPath })
    })

    transientStatFailures.delete(headPath)
    await appendFile(packedRefsPath, 'deadbeef refs/heads/other\n')
    await vi.waitFor(() => {
      expect(
        received.flat().filter((event) => event.path === packedRefsPath).length
      ).toBeGreaterThan(1)
    })
    // The unreadable file is held at its last known mtime: never a fabricated delete, and recovery
    // is silent because the retained value still matches.
    expect(received.flat().filter((event) => event.path === headPath)).toEqual([])
  })

  it('accepts a partial baseline when one primary file is unreadable from the start', async () => {
    installSubscribeMock()
    const commonDir = await makeCommonDir(true)
    const headPath = join(commonDir, 'HEAD')
    const headLogPath = join(commonDir, 'logs', 'HEAD')
    await writeFile(headPath, 'ref: refs/heads/main\n')
    await mkdir(join(commonDir, 'logs'))
    await writeFile(headLogPath, '')
    // Unreadable before the watch even starts, so no clean scan is ever available to baseline from.
    transientStatFailures.set(headLogPath, 1_000)
    const received: WorktreeBasePollEvent[][] = []
    await startWatch(commonDir, received)

    await vi.waitFor(() => {
      expect(received.flat()).toContainEqual({ type: 'update', path: headPath })
    })
    const updatesBeforeWrite = received.flat().filter((event) => event.path === headPath).length
    await appendFile(headPath, 'ref: refs/heads/other\n')

    // The readable files stay watched for the whole outage instead of going silent behind a
    // baseline that can never be taken.
    await vi.waitFor(() => {
      expect(received.flat().filter((event) => event.path === headPath).length).toBeGreaterThan(
        updatesBeforeWrite
      )
    })
  })

  it('settles to the idle cadence while a primary file stays unreadable', async () => {
    installSubscribeMock()
    const commonDir = await makeCommonDir(true)
    const headPath = join(commonDir, 'HEAD')
    await writeFile(headPath, 'ref: refs/heads/main\n')
    const activeMs = 20
    const idleMs = 500
    const polledAt: number[] = []
    const watch = await startGitCommonWatch(
      makeTarget(commonDir),
      () => {},
      activeMs,
      'darwin',
      alwaysVisible,
      () => polledAt.push(performance.now()),
      idleMs,
      idleMs * 3
    )
    cleanups.push(() => watch.unsubscribe())
    transientStatFailures.set(headPath, 1_000)

    // A degraded tick observed nothing new, so it must count toward the unchanged run rather than
    // resetting it — a flaky mount would otherwise hold the active interval forever.
    await vi.waitFor(() => expect(polledAt.length).toBeGreaterThanOrEqual(5), { timeout: 5_000 })
    expect(polledAt.at(-1)! - polledAt.at(-2)!).toBeGreaterThan(idleMs / 2)
  })

  it('resets the idle primary poll when the native stream reports activity', async () => {
    installSubscribeMock()
    const commonDir = await makeCommonDir(true)
    const fullScans: number[] = []
    const watch = await startGitCommonWatch(
      makeTarget(commonDir),
      () => {},
      POLL_MS,
      'darwin',
      alwaysVisible,
      () => fullScans.push(performance.now()),
      1_000,
      3_000
    )
    cleanups.push(() => watch.unsubscribe())

    await vi.waitFor(() => expect(fullScans.length).toBeGreaterThanOrEqual(3))
    const scansBeforeNativeEvent = fullScans.length
    childSubscriptions[0].callback(null, [
      { type: 'update', path: join(commonDir, 'worktrees', 'native-change', 'HEAD') }
    ])
    await vi.waitFor(() => expect(fullScans.length).toBeGreaterThan(scansBeforeNativeEvent), {
      timeout: 250
    })
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

  async function startHiddenExistencePoll(visibility: {
    source: WorktreePollerWindowVisibility
    hide: () => void
  }): Promise<{ commonDir: string; worktreesDir: string; received: WorktreeBasePollEvent[][] }> {
    const commonDir = await makeCommonDir(false)
    const received: WorktreeBasePollEvent[][] = []
    const watch = await startGitCommonWatch(
      makeTarget(commonDir),
      (events) => received.push(events),
      POLL_MS,
      'darwin',
      visibility.source,
      undefined,
      IDLE_POLL_MS,
      BACKSTOP_MS
    )
    cleanups.push(() => watch.unsubscribe())
    visibility.hide()
    // Let the armed poll observe the hidden window and park itself.
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4))
    statCalls.length = 0
    return { commonDir, worktreesDir: join(commonDir, 'worktrees'), received }
  }

  it('parks the existence poll while the window is hidden', async () => {
    installSubscribeMock()
    const visibility = createVisibilityHarness()
    const { worktreesDir, received } = await startHiddenExistencePoll(visibility)

    await mkdir(worktreesDir)
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4))

    expect(statCalls.filter((path) => path === worktreesDir)).toHaveLength(0)
    expect(subscribeMock).not.toHaveBeenCalled()
    expect(received.flat()).toHaveLength(0)
  })

  it('re-checks on show and still reports a worktrees dir created while hidden', async () => {
    installSubscribeMock()
    const visibility = createVisibilityHarness()
    const { worktreesDir, received } = await startHiddenExistencePoll(visibility)

    await mkdir(worktreesDir)
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4))
    expect(subscribeMock).not.toHaveBeenCalled()

    visibility.show()
    // Promptly: the re-check stats on show, not a poll interval later.
    expect(statCalls.filter((path) => path === worktreesDir)).toHaveLength(1)
    await vi.waitFor(() => {
      expect(subscribeMock).toHaveBeenCalledTimes(1)
    })
    expect(received.flat()).toContainEqual({ type: 'create', path: worktreesDir })
  })

  it('resumes polling when the dir is still absent on show', async () => {
    installSubscribeMock()
    const visibility = createVisibilityHarness()
    const { worktreesDir } = await startHiddenExistencePoll(visibility)

    visibility.show()
    await mkdir(worktreesDir)
    await vi.waitFor(() => {
      expect(subscribeMock).toHaveBeenCalledTimes(1)
    })
  })

  it('keeps polling and reporting while the window stays visible', async () => {
    installSubscribeMock()
    const visibility = createVisibilityHarness()
    const commonDir = await makeCommonDir(false)
    const worktreesDir = join(commonDir, 'worktrees')
    const received: WorktreeBasePollEvent[][] = []
    const watch = await startGitCommonWatch(
      makeTarget(commonDir),
      (events) => received.push(events),
      POLL_MS,
      'darwin',
      visibility.source,
      undefined,
      IDLE_POLL_MS,
      BACKSTOP_MS
    )
    cleanups.push(() => watch.unsubscribe())

    await mkdir(worktreesDir)
    await vi.waitFor(() => {
      expect(subscribeMock).toHaveBeenCalledTimes(1)
    })
    expect(received.flat()).toContainEqual({ type: 'create', path: worktreesDir })
  })

  it('drops both visibility subscriptions on dispose', async () => {
    installSubscribeMock()
    const visibility = createVisibilityHarness()
    const commonDir = await makeCommonDir(false)
    const watch = await startGitCommonWatch(
      makeTarget(commonDir),
      () => {},
      POLL_MS,
      'darwin',
      visibility.source,
      undefined,
      IDLE_POLL_MS,
      BACKSTOP_MS
    )

    // Narrow watch + primary-metadata poll each park on window visibility.
    expect(visibility.listenerCount()).toBe(2)
    await watch.unsubscribe()
    expect(visibility.listenerCount()).toBe(0)
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
      () => fullScans.push(Date.now()),
      IDLE_POLL_MS,
      BACKSTOP_MS
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
      alwaysVisible,
      undefined,
      IDLE_POLL_MS,
      BACKSTOP_MS
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
    readdirFailureCodes.clear()
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
    transientStatFailures.clear()
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
      onFullScan,
      IDLE_POLL_MS,
      BACKSTOP_MS
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

  it('installs the poller and resyncs after a transient initial baseline failure', async () => {
    const commonDir = await makePollingCommonDir()
    const worktreesDir = join(commonDir, 'worktrees')
    transientStatFailures.set(worktreesDir, 1)
    const received: WorktreeBasePollEvent[][] = []

    await startPollingWatch(commonDir, received)

    await vi.waitFor(() => {
      expect(received.flat()).toContainEqual({ type: 'update', path: worktreesDir })
    })
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

  it('does not fabricate worktree deletions when the listing fails ENOTDIR', async () => {
    // Why: only ENOENT is an authoritative empty listing. ENOTDIR means the path exists as a FILE —
    // a stray temp file from a git operation — so the linked worktrees are still there.
    const commonDir = await makePollingCommonDir()
    const entry = join(commonDir, 'worktrees', 'keep')
    await mkdir(entry)
    await writeFile(join(entry, 'HEAD'), 'ref: refs/heads/main')
    const received: WorktreeBasePollEvent[][] = []
    await startPollingWatch(commonDir, received)

    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 2))
    readdirFailureCodes.set(join(commonDir, 'worktrees'), 'ENOTDIR')
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4))

    expect(received.flat()).not.toContainEqual({ type: 'delete', path: entry })
  })

  // Why runIf: same chmod-based EACCES injection constraint as the test above.
  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    "keeps re-stat'ing known entries while the readdir keeps failing",
    async () => {
      // Why: a failing listing must cost the tick only what it could not observe. Mode 0o111 revokes
      // read (readdir → EACCES) while keeping traverse, so the known entry's leaves are still
      // readable — an in-place HEAD rewrite must still surface instead of waiting out the outage.
      const commonDir = await makePollingCommonDir()
      const entry = join(commonDir, 'worktrees', 'live')
      await mkdir(entry)
      const headPath = join(entry, 'HEAD')
      await writeFile(headPath, 'ref: refs/heads/main')
      const received: WorktreeBasePollEvent[][] = []
      await startPollingWatch(commonDir, received)

      await new Promise((resolve) => setTimeout(resolve, POLL_MS * 2))
      const worktreesDir = join(commonDir, 'worktrees')
      chmodSync(worktreesDir, 0o111)
      try {
        // Guard against a vacuous pass: the listing must really be denied on this filesystem.
        await expect(readdir(worktreesDir)).rejects.toThrow()
        await writeFile(headPath, 'ref: refs/heads/feature-branch')
        await vi.waitFor(() => {
          expect(received.flat()).toContainEqual({ type: 'update', path: headPath })
        })
      } finally {
        chmodSync(worktreesDir, 0o755)
      }
      expect(received.flat()).not.toContainEqual({ type: 'delete', path: entry })
    }
  )

  it('reports the other entries when one entry keeps failing to stat', async () => {
    // Why: a per-leaf fs error must not throw away the whole tick. The stuck entry keeps its previous
    // view (no fabricated delete) while its sibling's change is still reported on the same tick.
    const commonDir = await makePollingCommonDir()
    const stuck = join(commonDir, 'worktrees', 'stuck')
    const healthy = join(commonDir, 'worktrees', 'healthy')
    await mkdir(stuck)
    await mkdir(healthy)
    await writeFile(join(stuck, 'HEAD'), 'ref: refs/heads/main')
    const healthyHead = join(healthy, 'HEAD')
    await writeFile(healthyHead, 'ref: refs/heads/main')
    const received: WorktreeBasePollEvent[][] = []
    await startPollingWatch(commonDir, received)

    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 2))
    transientStatFailures.set(join(stuck, 'HEAD'), 1_000)
    await writeFile(healthyHead, 'ref: refs/heads/feature-branch')

    await vi.waitFor(() => {
      expect(received.flat()).toContainEqual({ type: 'update', path: healthyHead })
    })
    expect(received.flat()).not.toContainEqual({ type: 'delete', path: stuck })
    expect(received.flat().filter((event) => event.path.startsWith(stuck))).toEqual([])
    // Guard against a vacuous pass: the injected leaf failure really fired.
    expect(transientStatFailures.get(join(stuck, 'HEAD'))).toBeLessThan(1_000)
  })

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
