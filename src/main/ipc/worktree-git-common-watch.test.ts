import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import { performance as nodePerformance } from 'node:perf_hooks'
import { updateActiveGitStatusRefBinding } from './worktree-git-status-ref-watch'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { subscribeViaWatcherProcess } from './parcel-watcher-process'
import { WatcherProcessFailure } from './parcel-watcher-process-failure'
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
const { statCalls } = vi.hoisted(() => ({ statCalls: [] as string[] }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    stat: (...args: Parameters<typeof actual.stat>) => {
      statCalls.push(String(args[0]))
      return actual.stat(...args)
    }
  }
})

const POLL_MS = 25
// Reconciliation runs every 15 poll ticks. Fake timers keep native re-arm tests
// independent of host load while preserving the production interval.
const RECONCILIATION_TICKS = 15
// Advance one extra reconciliation window so the fake performance clock crosses the
// 15-tick boundary even when timer and filesystem-promise scheduling differ by a tick.
const alwaysVisible: WorktreePollerWindowVisibility = {
  isWindowVisible: () => true,
  onWindowBecameVisible: () => () => {}
}

let inodeReservationCount = 0

async function replaceWorktreesRoot(
  commonDir: string,
  worktreesDir: string,
  retainedEntry: string
): Promise<void> {
  const previousInode = (await stat(worktreesDir)).ino
  await rm(worktreesDir, { recursive: true })
  // Linux reuses freed directory inodes, and removing the tree frees several at
  // once, so the recreated root can land back on its own old inode and look
  // unchanged to reconciliation. Park inodes in HELD siblings until the root
  // genuinely differs — verifying beats guessing how many to reserve. The
  // siblings live next to `worktrees`, which no poll or watch path enumerates.
  for (let attempt = 0; attempt < 16; attempt++) {
    await mkdir(retainedEntry, { recursive: true })
    if ((await stat(worktreesDir)).ino !== previousInode) {
      return
    }
    await rm(worktreesDir, { recursive: true })
    await mkdir(join(commonDir, `worktrees-inode-hold-${++inodeReservationCount}`))
  }
  throw new Error('could not obtain a fresh inode for the replaced worktrees root')
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
  unsubscribe: ReturnType<typeof vi.fn<() => Promise<void>>>
}

describe('worktree git-common narrow watch (local native platforms)', () => {
  const cleanups: (() => Promise<void>)[] = []
  const subscribeMock = vi.mocked(subscribeViaWatcherProcess)
  let childSubscriptions: ChildSubscription[] = []

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
    childSubscriptions = []
    statCalls.length = 0
    subscribeMock.mockReset()
  })

  function installSubscribeMock(): void {
    subscribeMock.mockImplementation(async (dir, callback, _opts, hooks = {}) => {
      const unsubscribe = vi.fn(async () => {})
      childSubscriptions.push({ dir, callback, hooks, unsubscribe })
      return { unsubscribe }
    })
  }

  function narrowSubscriptions(): ChildSubscription[] {
    return childSubscriptions.filter((subscription) => subscription.dir.endsWith('worktrees'))
  }

  function narrowSubscription(): ChildSubscription {
    const subscription = narrowSubscriptions()[0]
    if (!subscription) {
      throw new Error('narrow watcher subscription not installed')
    }
    return subscription
  }

  function primarySubscription(): ChildSubscription {
    const subscription = childSubscriptions.find((item) => !item.dir.endsWith('worktrees'))
    if (!subscription) {
      throw new Error('primary watcher subscription not installed')
    }
    return subscription
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

  async function startWatch(
    commonDir: string,
    received: WorktreeBasePollEvent[][],
    getStatusRefPaths: () => readonly string[] = () => [],
    onWatchError?: (error: Error) => void,
    platform: NodeJS.Platform = 'darwin'
  ): Promise<void> {
    const watch = await startGitCommonWatch(
      makeTarget(commonDir),
      (events) => received.push(events),
      POLL_MS,
      platform,
      alwaysVisible,
      undefined,
      getStatusRefPaths,
      onWatchError
    )
    cleanups.push(() => watch.unsubscribe())
  }

  it('hosts the narrow stream in the watcher child, not in-process', async () => {
    installSubscribeMock()
    const commonDir = await makeCommonDir(true)
    const received: WorktreeBasePollEvent[][] = []
    await startWatch(commonDir, received)

    expect(subscribeMock).toHaveBeenCalledTimes(2)
    const narrowCall = subscribeMock.mock.calls.find(
      ([dir]) => dir === join(commonDir, 'worktrees')
    )
    expect(narrowCall?.[0]).toBe(join(commonDir, 'worktrees'))
    expect(narrowCall?.[2]).toEqual({})

    const entryPath = join(commonDir, 'worktrees', 'wt-a')
    narrowSubscription().callback(null, [{ type: 'create', path: entryPath }])
    expect(received.flat()).toContainEqual({ type: 'create', path: entryPath })
  })

  it.each(['linux', 'win32'] as const)(
    'uses the crash-isolated narrow stream on %s',
    async (platform) => {
      installSubscribeMock()
      const commonDir = await makeCommonDir(true)
      const received: WorktreeBasePollEvent[][] = []
      await startWatch(commonDir, received, undefined, undefined, platform)

      expect(subscribeMock).toHaveBeenCalledTimes(2)
      const narrowCall = subscribeMock.mock.calls.find(([dir]) => dir.endsWith('worktrees'))
      expect(narrowCall?.[2]).toEqual(platform === 'win32' ? { backend: 'windows' } : {})
      const entryPath = join(commonDir, 'worktrees', `${platform}-entry`)
      narrowSubscription().callback(null, [{ type: 'create', path: entryPath }])
      expect(received.flat()).toContainEqual({ type: 'create', path: entryPath })
    }
  )

  it('detects a common config write via the shallow primary-metadata watcher', async () => {
    // Why: an external `git push -u` rewrites only the common config (plus
    // remote-tracking refs) — outside the narrow worktrees/ stream.
    installSubscribeMock()
    const commonDir = await makeCommonDir(true)
    const configPath = join(commonDir, 'config')
    await writeFile(configPath, '[core]\n\tbare = false\n')
    const received: WorktreeBasePollEvent[][] = []
    await startWatch(commonDir, received)

    await appendFile(configPath, '[branch "main"]\n\tremote = origin\n')
    primarySubscription().callback(null, [{ type: 'update', path: configPath }])
    await vi.waitFor(() => {
      expect(received.flat()).toContainEqual({ type: 'update', path: configPath })
    })
  })

  it('keeps primary metadata off the per-tick path but re-stats it on the backstop', async () => {
    installSubscribeMock()
    const commonDir = await makeCommonDir(true)
    const headPath = join(commonDir, 'HEAD')
    const configPath = join(commonDir, 'config')
    await Promise.all([
      writeFile(headPath, 'ref: refs/heads/main'),
      writeFile(configPath, '[core]\n')
    ])

    const received: WorktreeBasePollEvent[][] = []
    await startWatch(commonDir, received)
    expect(primarySubscription().dir).toBe(commonDir)

    // The shallow child owns the fast path: ordinary ticks must not re-stat these.
    statCalls.length = 0
    await vi
      .waitFor(
        () => {
          expect(statCalls.length).toBeGreaterThan(0)
        },
        { timeout: 2_000 }
      )
      .catch(() => {})
    const duringOrdinaryTicks = statCalls.filter(
      (path) => path === headPath || path === configPath
    ).length

    // ...but a bounded backstop must still re-stat them, or a watcher that goes
    // silently lossy would leave primary metadata stale forever.
    statCalls.length = 0
    await vi.waitFor(
      () => {
        expect(statCalls).toContain(headPath)
        expect(statCalls).toContain(configPath)
      },
      { timeout: POLL_MS * RECONCILIATION_TICKS * 6 }
    )
    const backstopSamples = statCalls.filter((path) => path === headPath).length
    expect(duringOrdinaryTicks).toBeLessThan(backstopSamples * RECONCILIATION_TICKS)
  })

  it('drops the ref poller when the binding moves away, leaving no orphan', async () => {
    installSubscribeMock()
    const commonDir = await makeCommonDir(true)
    await mkdir(join(commonDir, 'refs', 'remotes', 'origin'), { recursive: true })
    await writeFile(join(commonDir, 'refs', 'remotes', 'origin', 'main'), 'aaa\n')
    const visibility = createVisibilityHarness()
    const target = makeTarget(commonDir)
    const watchTarget = {
      kind: target.kind,
      path: target.path,
      repos: target.repos,
      gitStatusRefPaths: new Set<string>()
    }
    const watch = await startGitCommonWatch(
      target,
      () => {},
      POLL_MS,
      'darwin',
      visibility.source,
      undefined,
      () => [...watchTarget.gitStatusRefPaths]
    )
    cleanups.push(() => watch.unsubscribe())
    const baseline = visibility.listenerCount()

    const bind = (branch?: string): Promise<void> =>
      updateActiveGitStatusRefBinding(
        {
          worktreeId: `${[...target.repos.keys()][0]}::${commonDir}`,
          worktreePath: commonDir,
          executionHostId: 'local',
          branch,
          upstreamName: branch ? 'origin/main' : undefined
        },
        () => [watchTarget],
        async () => 'refs/remotes/origin/main'
      )

    // Bind then unbind repeatedly: each cycle must hand back whatever it took.
    for (let round = 0; round < 4; round++) {
      await bind('main')
      await vi.waitFor(() => {
        expect(visibility.listenerCount()).toBeGreaterThan(baseline)
      })
      await bind(undefined)
      await vi.waitFor(() => {
        expect(visibility.listenerCount()).toBe(baseline)
      })
    }

    await watch.unsubscribe()
    cleanups.pop()
    expect(visibility.listenerCount()).toBe(0)
  })

  it('polls only the accepted upstream ref and rebinds without synthetic events', async () => {
    installSubscribeMock()
    const commonDir = await makeCommonDir(true)
    const firstRef = join(commonDir, 'refs', 'remotes', 'origin', 'first')
    const nextRef = join(commonDir, 'refs', 'remotes', 'origin', 'next')
    const unrelatedRef = join(commonDir, 'refs', 'remotes', 'origin', 'unrelated')
    await mkdir(join(commonDir, 'refs', 'remotes', 'origin'), { recursive: true })
    await Promise.all([
      writeFile(firstRef, 'aaa\n'),
      writeFile(nextRef, 'bbb\n'),
      writeFile(unrelatedRef, 'ccc\n')
    ])
    let selected = [firstRef]
    const received: WorktreeBasePollEvent[][] = []
    await startWatch(commonDir, received, () => selected)

    statCalls.length = 0
    await appendFile(firstRef, 'updated\n')
    await vi.waitFor(() => {
      expect(received.flat()).toContainEqual({ type: 'update', path: firstRef })
    })
    expect(statCalls).not.toContain(unrelatedRef)

    received.length = 0
    selected = [nextRef]
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 2))
    expect(received.flat()).toEqual([])
    await appendFile(firstRef, 'ignored\n')
    await appendFile(nextRef, 'watched\n')
    await vi.waitFor(() => {
      expect(received.flat()).toContainEqual({ type: 'update', path: nextRef })
    })
    expect(received.flat()).not.toContainEqual({ type: 'update', path: firstRef })
  })

  it('tears down and re-arms when the watched root is deleted', async () => {
    installSubscribeMock()
    const commonDir = await makeCommonDir(true)
    const worktreesDir = join(commonDir, 'worktrees')
    const received: WorktreeBasePollEvent[][] = []
    await startWatch(commonDir, received)

    await rm(worktreesDir, { recursive: true, force: true })
    narrowSubscription().callback(null, [{ type: 'delete', path: worktreesDir }])
    await vi.waitFor(() => {
      expect(narrowSubscription().unsubscribe).toHaveBeenCalledTimes(1)
    })
    expect(received.flat()).toContainEqual({ type: 'delete', path: worktreesDir })

    // The existence poll re-subscribes once a new first worktree recreates it.
    await mkdir(worktreesDir)
    await vi.waitFor(() => {
      expect(subscribeMock).toHaveBeenCalledTimes(3)
    })
    expect(received.flat()).toContainEqual({ type: 'create', path: worktreesDir })
  })

  it('tears down and re-arms on watcher errors', async () => {
    installSubscribeMock()
    const commonDir = await makeCommonDir(true)
    const worktreesDir = join(commonDir, 'worktrees')
    const received: WorktreeBasePollEvent[][] = []
    await startWatch(commonDir, received)

    narrowSubscription().callback(new Error('watcher child reported failure'), [])
    await vi.waitFor(() => {
      expect(narrowSubscription().unsubscribe).toHaveBeenCalledTimes(1)
    })
    // The error is surfaced as a structural change so worktrees re-sync.
    expect(received.flat()).toContainEqual({ type: 'update', path: worktreesDir })

    // The dir still exists, so the existence poll re-subscribes.
    await vi.waitFor(() => {
      expect(subscribeMock).toHaveBeenCalledTimes(3)
    })

    const receivedAfterRearm = received.length
    narrowSubscription().callback(new Error('late error from replaced watcher'), [])
    narrowSubscription().callback(null, [
      { type: 'create', path: join(worktreesDir, 'late-old-event') }
    ])
    narrowSubscription().hooks.onInterruption?.()

    // A replaced watch cannot tear down its successor or report stale events.
    expect(received).toHaveLength(receivedAfterRearm)
    expect(narrowSubscriptions()[1].unsubscribe).not.toHaveBeenCalled()
  })

  it('routes watcher failures through the unknown-metadata callback', async () => {
    installSubscribeMock()
    const commonDir = await makeCommonDir(true)
    const received: WorktreeBasePollEvent[][] = []
    const onWatchError = vi.fn()
    await startWatch(commonDir, received, () => [], onWatchError)

    const error = new Error('watcher child reported failure')
    narrowSubscription().callback(error, [])

    expect(onWatchError).toHaveBeenCalledWith(error)
    expect(received).toEqual([])
  })

  it('falls back to structural polling after the watcher crash fuse opens', async () => {
    installSubscribeMock()
    const commonDir = await makeCommonDir(true)
    const worktreesDir = join(commonDir, 'worktrees')
    const visibility = createVisibilityHarness()
    const received: WorktreeBasePollEvent[][] = []
    const watch = await startGitCommonWatch(
      makeTarget(commonDir),
      (events) => received.push(events),
      POLL_MS,
      'darwin',
      visibility.source
    )

    narrowSubscription().callback(
      new WatcherProcessFailure(
        'watcher process crashed repeatedly',
        'supervisor',
        'supervisor_crash_fuse'
      ),
      []
    )
    // Narrow fallback + primary backstop, with the narrow existence poll retired.
    // No upstream ref is selected here, so no selected-ref poll is scheduled at
    // all. Waiting on the exact count is what guarantees the fallback has
    // baselined before the entry below is created.
    await vi.waitFor(() => {
      expect(narrowSubscription().unsubscribe).toHaveBeenCalledOnce()
      expect(visibility.listenerCount()).toBe(3)
    })

    const entryPath = join(worktreesDir, 'fallback-entry')
    await mkdir(entryPath)
    await vi.waitFor(() => {
      expect(received.flat()).toContainEqual({ type: 'create', path: entryPath })
    })
    await rm(entryPath, { recursive: true })
    await vi.waitFor(() => {
      expect(received.flat()).toContainEqual({ type: 'delete', path: entryPath })
    })
    expect(subscribeMock).toHaveBeenCalledTimes(2)
    await watch.unsubscribe()
    expect(visibility.listenerCount()).toBe(0)
  })

  it('starts structural polling when the watcher process is already unavailable', async () => {
    subscribeMock.mockRejectedValue(
      new WatcherProcessFailure('watcher process unavailable', 'supervisor', 'process_unavailable')
    )
    const commonDir = await makeCommonDir(true)
    const worktreesDir = join(commonDir, 'worktrees')
    const visibility = createVisibilityHarness()
    const received: WorktreeBasePollEvent[][] = []
    const watch = await startGitCommonWatch(
      makeTarget(commonDir),
      (events) => received.push(events),
      POLL_MS,
      'darwin',
      visibility.source
    )

    const entryPath = join(worktreesDir, 'fallback-entry')
    await mkdir(entryPath)
    await vi.waitFor(() => {
      expect(received.flat()).toContainEqual({ type: 'create', path: entryPath })
    })
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 2))
    expect(subscribeMock).toHaveBeenCalledTimes(2)

    await watch.unsubscribe()
    expect(visibility.listenerCount()).toBe(0)
  })

  it('reports a structural change after a watcher-child interruption', async () => {
    installSubscribeMock()
    const commonDir = await makeCommonDir(true)
    const worktreesDir = join(commonDir, 'worktrees')
    const received: WorktreeBasePollEvent[][] = []
    await startWatch(commonDir, received)

    narrowSubscription().hooks.onInterruption?.()
    expect(received.flat()).toContainEqual({ type: 'update', path: worktreesDir })
    // The supervisor resubscribed the same record; no teardown should happen.
    expect(narrowSubscription().unsubscribe).not.toHaveBeenCalled()
  })

  it('arms via existence polling when the worktrees dir appears later', async () => {
    installSubscribeMock()
    const commonDir = await makeCommonDir(false)
    const received: WorktreeBasePollEvent[][] = []
    await startWatch(commonDir, received)
    expect(subscribeMock).toHaveBeenCalledTimes(1)

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
      visibility.source
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
    expect(subscribeMock).toHaveBeenCalledTimes(1)
    expect(received.flat()).toHaveLength(0)
  })

  it('re-checks on show and still reports a worktrees dir created while hidden', async () => {
    installSubscribeMock()
    const visibility = createVisibilityHarness()
    const { worktreesDir, received } = await startHiddenExistencePoll(visibility)

    await mkdir(worktreesDir)
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4))
    expect(subscribeMock).toHaveBeenCalledTimes(1)

    visibility.show()
    // Promptly: the re-check stats on show, not a poll interval later.
    expect(statCalls.filter((path) => path === worktreesDir)).toHaveLength(1)
    await vi.waitFor(() => {
      expect(subscribeMock).toHaveBeenCalledTimes(2)
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
      visibility.source
    )
    cleanups.push(() => watch.unsubscribe())

    await mkdir(worktreesDir)
    await vi.waitFor(() => {
      expect(subscribeMock).toHaveBeenCalledTimes(2)
      expect(received.flat()).toContainEqual({ type: 'create', path: worktreesDir })
    })
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
      visibility.source
    )

    // Narrow existence and the primary backstop park on window visibility. No
    // upstream ref is selected, so no selected-ref poll exists to park.
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
      () => fullScans.push(Date.now())
    )
    cleanups.push(() => watch.unsubscribe())

    visibility.hide()
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 2))
    await writeFile(headFile, 'ref: refs/heads/feature')
    primarySubscription().callback(null, [{ type: 'update', path: headFile }])

    expect(fullScans).toHaveLength(0)
    const entryPath = join(commonDir, 'worktrees', 'native-while-hidden')
    narrowSubscription().callback(null, [{ type: 'create', path: entryPath }])
    expect(received.flat()).toContainEqual({ type: 'create', path: entryPath })
    expect(narrowSubscription().unsubscribe).not.toHaveBeenCalled()

    visibility.show()
    expect(fullScans).toHaveLength(0)
  })

  it('re-arms the native stream when the root is replaced with the same child names', async () => {
    vi.useFakeTimers()
    const restorePerformanceNow = vi
      .spyOn(nodePerformance, 'now')
      .mockImplementation(() => Date.now())
    try {
      installSubscribeMock()
      const commonDir = await makeCommonDir(true)
      const worktreesDir = join(commonDir, 'worktrees')
      const retainedEntry = join(worktreesDir, 'same-child')
      await mkdir(retainedEntry)
      const received: WorktreeBasePollEvent[][] = []
      await startWatch(commonDir, received)
      const staleSubscription = narrowSubscription()

      await replaceWorktreesRoot(commonDir, worktreesDir, retainedEntry)
      await vi.advanceTimersByTimeAsync(POLL_MS * RECONCILIATION_TICKS * 4)
      // Reconciliation's snapshot is real filesystem work, so advancing the fake
      // clock schedules it but does not guarantee it has settled.
      await vi.waitFor(
        () => {
          expect(subscribeMock).toHaveBeenCalledTimes(3)
          expect(staleSubscription.unsubscribe).toHaveBeenCalledOnce()
        },
        { timeout: 2_000 }
      )

      const beforeStaleEvent = received.length
      staleSubscription.callback(null, [{ type: 'update', path: retainedEntry }])
      expect(received).toHaveLength(beforeStaleEvent)

      const immediateEntry = join(worktreesDir, 'after-rearm')
      narrowSubscriptions()[1].callback(null, [{ type: 'create', path: immediateEntry }])
      expect(received.flat()).toContainEqual({ type: 'create', path: immediateEntry })
    } finally {
      await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
      restorePerformanceNow.mockRestore()
      vi.useRealTimers()
    }
  })

  it('disposes an in-flight stale resubscribe and fences its interruption hook', async () => {
    vi.useFakeTimers()
    const restorePerformanceNow = vi
      .spyOn(nodePerformance, 'now')
      .mockImplementation(() => Date.now())
    try {
      const deferredSubscribe = Promise.withResolvers<{
        unsubscribe: () => Promise<void>
      }>()
      subscribeMock.mockImplementation(async (dir, callback, _opts, hooks = {}) => {
        const unsubscribe = vi.fn(async () => {})
        childSubscriptions.push({ dir, callback, hooks, unsubscribe })
        return narrowSubscriptions().length === 2 ? deferredSubscribe.promise : { unsubscribe }
      })
      const commonDir = await makeCommonDir(true)
      const worktreesDir = join(commonDir, 'worktrees')
      const retainedEntry = join(worktreesDir, 'same-child')
      await mkdir(retainedEntry)
      const received: WorktreeBasePollEvent[][] = []
      const onWatchError = vi.fn()
      await startWatch(commonDir, received, () => [], onWatchError)

      await replaceWorktreesRoot(commonDir, worktreesDir, retainedEntry)
      await vi.advanceTimersByTimeAsync(POLL_MS * RECONCILIATION_TICKS * 4)
      await vi.waitFor(
        () => {
          expect(subscribeMock).toHaveBeenCalledTimes(3)
          expect(narrowSubscriptions()[1]).toBeDefined()
        },
        { timeout: 1_000 }
      )
      const stalePendingSubscription = narrowSubscriptions()[1]
      await replaceWorktreesRoot(commonDir, worktreesDir, retainedEntry)
      await vi.advanceTimersByTimeAsync(POLL_MS * RECONCILIATION_TICKS * 4)
      expect(
        received.flat().filter((event) => event.type === 'create' && event.path === worktreesDir)
      ).toHaveLength(2)

      const beforeStaleInterruption = received.length
      stalePendingSubscription.hooks.onInterruption?.()
      expect(received).toHaveLength(beforeStaleInterruption)
      expect(onWatchError).not.toHaveBeenCalled()

      deferredSubscribe.resolve({
        unsubscribe: async () => {
          await stalePendingSubscription.unsubscribe()
        }
      })
      await vi.advanceTimersByTimeAsync(POLL_MS)
      await vi.waitFor(
        () => {
          expect(subscribeMock).toHaveBeenCalledTimes(4)
          expect(stalePendingSubscription.unsubscribe).toHaveBeenCalledOnce()
        },
        { timeout: 1_000 }
      )

      const immediateEntry = join(worktreesDir, 'current-generation')
      narrowSubscriptions()[2].callback(null, [{ type: 'create', path: immediateEntry }])
      expect(received.flat()).toContainEqual({ type: 'create', path: immediateEntry })
    } finally {
      await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
      restorePerformanceNow.mockRestore()
      vi.useRealTimers()
    }
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
    expect(narrowSubscription().unsubscribe).toHaveBeenCalledTimes(1)

    received.length = 0
    narrowSubscription().callback(null, [
      { type: 'create', path: join(commonDir, 'worktrees', 'late') }
    ])
    expect(received).toHaveLength(0)
  })
})
