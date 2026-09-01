import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import { performance as nodePerformance } from 'node:perf_hooks'
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
// Records every stat target so a test can assert which paths a gated tick stopped touching.
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
// Reconciliation runs every 15 poll ticks (see NARROW_WATCH_RECONCILIATION_TICKS).
const RECONCILIATION_TICKS = 15
// Mirrors BELT_AND_BRACES_SWEEP_TICKS in worktree-git-common-watch-reconciliation.ts.
const BELT_AND_BRACES_TICKS = 10

const alwaysVisible: WorktreePollerWindowVisibility = {
  isWindowVisible: () => true,
  onWindowBecameVisible: () => () => {}
}

type ChildSubscription = {
  dir: string
  callback: WatcherProcessCallback
  hooks: WatcherProcessHooks
  unsubscribe: ReturnType<typeof vi.fn<() => Promise<void>>>
}

// This suite exercises the git-common reconciliation backstop's sweep gating
// (the O(1) tripwire, loss signals, and the belt-and-braces cadence) — split
// out of worktree-git-common-watch.test.ts to stay under the file's max-lines budget.
describe('git-common watch reconciliation backstop', () => {
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

  function narrowSubscription(): ChildSubscription {
    const subscription = childSubscriptions.find((item) => item.dir.endsWith('worktrees'))
    if (!subscription) {
      throw new Error('narrow watcher subscription not installed')
    }
    return subscription
  }

  async function makeCommonDir(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'orca-git-common-reconciliation-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const commonDir = await realpath(root)
    await mkdir(join(commonDir, 'worktrees'))
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

  async function makeEntryWithHead(worktreesDir: string, name: string): Promise<string> {
    const entryDir = join(worktreesDir, name)
    await mkdir(entryDir)
    const headPath = join(entryDir, 'HEAD')
    await writeFile(headPath, 'ref: refs/heads/main')
    return headPath
  }

  it('skips the per-entry sweep on idle reconciliation ticks, stat-ing only the tripwire root', async () => {
    vi.useFakeTimers()
    const restorePerformanceNow = vi
      .spyOn(nodePerformance, 'now')
      .mockImplementation(() => Date.now())
    try {
      installSubscribeMock()
      const commonDir = await makeCommonDir()
      const worktreesDir = join(commonDir, 'worktrees')
      const entryHead = await makeEntryWithHead(worktreesDir, 'wt-idle')
      const received: WorktreeBasePollEvent[][] = []
      await startWatch(commonDir, received)

      // Baseline snapshot already ran during startup; only ticks after this matter.
      statCalls.length = 0
      await vi.advanceTimersByTimeAsync(
        POLL_MS * RECONCILIATION_TICKS * (BELT_AND_BRACES_TICKS - 1)
      )

      // The O(1) tripwire still runs every tick...
      expect(statCalls.filter((path) => path === worktreesDir).length).toBeGreaterThan(0)
      // ...but the expensive per-entry sweep must not, since nothing changed
      // and the belt-and-braces cadence hasn't been reached yet.
      expect(statCalls).not.toContain(entryHead)
    } finally {
      await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
      restorePerformanceNow.mockRestore()
      vi.useRealTimers()
    }
  })

  it('sweeps on the belt-and-braces cadence even with no tripwire or loss signal', async () => {
    vi.useFakeTimers()
    const restorePerformanceNow = vi
      .spyOn(nodePerformance, 'now')
      .mockImplementation(() => Date.now())
    try {
      installSubscribeMock()
      const commonDir = await makeCommonDir()
      const worktreesDir = join(commonDir, 'worktrees')
      const entryHead = await makeEntryWithHead(worktreesDir, 'wt-belt-and-braces')
      const received: WorktreeBasePollEvent[][] = []
      await startWatch(commonDir, received)
      statCalls.length = 0

      // Advance one reconciliation tick at a time: a single large jump can
      // stall fake-timer/real-fs interleaving before the cadence is reached,
      // since each tick's tripwire stat is genuine async I/O.
      for (
        let tick = 0;
        tick < BELT_AND_BRACES_TICKS + 5 && !statCalls.includes(entryHead);
        tick++
      ) {
        await vi.advanceTimersByTimeAsync(POLL_MS * RECONCILIATION_TICKS)
      }
      expect(statCalls).toContain(entryHead)
    } finally {
      await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
      restorePerformanceNow.mockRestore()
      vi.useRealTimers()
    }
  })

  it('forces the next reconciliation tick to sweep after a dropped event batch', async () => {
    vi.useFakeTimers()
    const restorePerformanceNow = vi
      .spyOn(nodePerformance, 'now')
      .mockImplementation(() => Date.now())
    try {
      installSubscribeMock()
      const commonDir = await makeCommonDir()
      const worktreesDir = join(commonDir, 'worktrees')
      const entryHead = await makeEntryWithHead(worktreesDir, 'wt-overflow')
      const received: WorktreeBasePollEvent[][] = []
      await startWatch(commonDir, received)
      statCalls.length = 0

      narrowSubscription().hooks.onOverflow?.()
      // One tick, well short of the belt-and-braces cadence, with nothing
      // else changed — only the loss signal can be forcing this sweep.
      await vi.advanceTimersByTimeAsync(POLL_MS * RECONCILIATION_TICKS)
      await vi.waitFor(
        () => {
          expect(statCalls).toContain(entryHead)
        },
        { timeout: 1_000 }
      )
    } finally {
      await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
      restorePerformanceNow.mockRestore()
      vi.useRealTimers()
    }
  })

  it('forces the next reconciliation tick to sweep after a watcher interruption', async () => {
    vi.useFakeTimers()
    const restorePerformanceNow = vi
      .spyOn(nodePerformance, 'now')
      .mockImplementation(() => Date.now())
    try {
      installSubscribeMock()
      const commonDir = await makeCommonDir()
      const worktreesDir = join(commonDir, 'worktrees')
      const entryHead = await makeEntryWithHead(worktreesDir, 'wt-interruption')
      const received: WorktreeBasePollEvent[][] = []
      await startWatch(commonDir, received)
      statCalls.length = 0

      narrowSubscription().hooks.onInterruption?.()
      await vi.advanceTimersByTimeAsync(POLL_MS * RECONCILIATION_TICKS)
      await vi.waitFor(
        () => {
          expect(statCalls).toContain(entryHead)
        },
        { timeout: 1_000 }
      )
    } finally {
      await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
      restorePerformanceNow.mockRestore()
      vi.useRealTimers()
    }
  })

  it('detects a linked worktree added out-of-band via the root tripwire, gate still open', async () => {
    vi.useFakeTimers()
    const restorePerformanceNow = vi
      .spyOn(nodePerformance, 'now')
      .mockImplementation(() => Date.now())
    try {
      installSubscribeMock()
      const commonDir = await makeCommonDir()
      const worktreesDir = join(commonDir, 'worktrees')
      const received: WorktreeBasePollEvent[][] = []
      await startWatch(commonDir, received)
      received.length = 0

      const addedEntry = join(worktreesDir, 'wt-added-out-of-band')
      await mkdir(addedEntry)
      await writeFile(join(addedEntry, 'HEAD'), 'ref: refs/heads/main')

      await vi.advanceTimersByTimeAsync(POLL_MS * RECONCILIATION_TICKS)
      await vi.waitFor(
        () => {
          expect(received.flat()).toContainEqual({
            type: 'create',
            path: addedEntry
          })
        },
        { timeout: 2_000 }
      )

      received.length = 0
      await rm(addedEntry, { recursive: true })
      await vi.advanceTimersByTimeAsync(POLL_MS * RECONCILIATION_TICKS)
      await vi.waitFor(
        () => {
          expect(received.flat()).toContainEqual({
            type: 'delete',
            path: addedEntry
          })
        },
        { timeout: 2_000 }
      )
    } finally {
      await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
      restorePerformanceNow.mockRestore()
      vi.useRealTimers()
    }
  })
})
