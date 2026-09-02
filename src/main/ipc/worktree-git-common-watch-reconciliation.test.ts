import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { performance as nodePerformance } from 'node:perf_hooks'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { subscribeViaWatcherProcess } from './parcel-watcher-process'
import type { WorktreeBaseWatchTarget } from './worktree-base-directory-event-filter'
import type {
  WorktreeBasePollEvent,
  WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'
import { startGitCommonWatch } from './worktree-git-common-watch'
import { createGitCommonWatchReconciliation } from './worktree-git-common-watch-reconciliation'
import { startGitCommonPolling } from './worktree-git-common-polling'
import type * as WorktreeGitCommonPolling from './worktree-git-common-polling'

vi.mock('./parcel-watcher-process', () => ({
  subscribeViaWatcherProcess: vi.fn()
}))

vi.mock('./worktree-git-common-polling', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeGitCommonPolling>()
  return { ...actual, startGitCommonPolling: vi.fn(actual.startGitCommonPolling) }
})

const alwaysVisible: WorktreePollerWindowVisibility = {
  isWindowVisible: () => true,
  onWindowBecameVisible: () => () => {}
}

// This suite exercises the git-common reconciliation backstop: #17839 made an
// unchanged entry's own per-entry stat gate (in snapshotGitCommonEntry) cheap,
// so this backstop no longer needs an outer sweep-skipping gate — every
// regular tick just runs, and notifyLossSignal only requests an early,
// rate-bounded tick (the rate-limiting/coalescing contract itself is covered
// directly against startGitCommonPolling in worktree-git-common-polling.test.ts).
// Split out of worktree-git-common-watch.test.ts to stay under the file's
// max-lines budget.
describe('git-common watch reconciliation backstop', () => {
  describe('notifyLossSignal wiring', () => {
    const startGitCommonPollingMock = vi.mocked(startGitCommonPolling)

    afterEach(() => {
      startGitCommonPollingMock.mockReset()
    })

    it('requests an early tick on the active polling subscription, not a no-op', async () => {
      const requestEarlyTick = vi.fn()
      const unsubscribe = vi.fn(async () => {})
      startGitCommonPollingMock.mockResolvedValueOnce({ requestEarlyTick, unsubscribe })

      const reconciliation = createGitCommonWatchReconciliation({
        commonDirPath: '/tmp/orca-reconciliation-wiring',
        pollIntervalMs: 25,
        visibility: alwaysVisible,
        canStart: () => true,
        shouldKeep: () => true,
        onRootReplacement: () => {},
        onEvents: () => {}
      })

      await reconciliation.ensureStarted()
      expect(requestEarlyTick).not.toHaveBeenCalled()

      reconciliation.notifyLossSignal()
      reconciliation.notifyLossSignal()

      expect(requestEarlyTick).toHaveBeenCalledTimes(2)
      // Point 1: no outer sweep-skipping gate reaches startGitCommonPolling —
      // #17839's per-entry gate makes every regular tick affordable, and the
      // early-tick floor matches the primary poller's own proven-cheap cadence.
      const passedOptions = startGitCommonPollingMock.mock.calls[0]?.[7]
      expect(passedOptions).toEqual({ earlyTickMinIntervalMs: 25 })
    })

    it('is a safe no-op before a subscription exists', () => {
      const reconciliation = createGitCommonWatchReconciliation({
        commonDirPath: '/tmp/orca-reconciliation-wiring-unstarted',
        pollIntervalMs: 25,
        visibility: alwaysVisible,
        canStart: () => false,
        shouldKeep: () => true,
        onRootReplacement: () => {},
        onEvents: () => {}
      })

      expect(() => reconciliation.notifyLossSignal()).not.toThrow()
      expect(startGitCommonPollingMock).not.toHaveBeenCalled()
    })
  })

  describe('regular-tick sweep, no outer gate', () => {
    const cleanups: (() => Promise<void>)[] = []
    const subscribeMock = vi.mocked(subscribeViaWatcherProcess)

    afterEach(async () => {
      await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
      subscribeMock.mockReset()
    })

    function installSubscribeMock(): void {
      subscribeMock.mockImplementation(async () => ({ unsubscribe: vi.fn(async () => {}) }))
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
        repos: new Map([
          ['repo-1', { repoId: 'repo-1', repoName: 'project', nestWorkspaces: false }]
        ])
      }
    }

    const POLL_MS = 25
    // Reconciliation runs every 15 poll ticks (see NARROW_WATCH_RECONCILIATION_TICKS).
    const RECONCILIATION_TICKS = 15

    async function startWatch(
      commonDir: string,
      received: WorktreeBasePollEvent[][]
    ): Promise<void> {
      const watch = await startGitCommonWatch(
        makeTarget(commonDir),
        (events) => received.push(events),
        POLL_MS,
        'darwin',
        alwaysVisible
      )
      cleanups.push(() => watch.unsubscribe())
    }

    it('sweeps an in-place structural change on the very next regular tick, no loss signal needed', async () => {
      vi.useFakeTimers()
      const restorePerformanceNow = vi
        .spyOn(nodePerformance, 'now')
        .mockImplementation(() => Date.now())
      try {
        installSubscribeMock()
        const commonDir = await makeCommonDir()
        const worktreesDir = join(commonDir, 'worktrees')
        const entryDir = join(worktreesDir, 'wt-in-place')
        await mkdir(entryDir)
        const entryHead = join(entryDir, 'HEAD')
        await writeFile(entryHead, 'ref: refs/heads/main')

        const received: WorktreeBasePollEvent[][] = []
        await startWatch(commonDir, received)
        received.length = 0

        // Structural change to an existing entry's HEAD, via the lock+rename
        // dance every real git ref write uses (never an in-place overwrite) —
        // that moves the entry dir's own signature, tripping #17839's
        // per-entry gate. worktreesDir's own signature never moves for this
        // (only entry add/remove does), so a top-level tripwire gating the
        // whole sweep would miss it entirely until a much slower backstop
        // cadence. Dropping that outer gate means this must surface on the
        // next ordinary tick, without a loss signal.
        const entryHeadLock = join(entryDir, 'HEAD.lock')
        await writeFile(entryHeadLock, 'ref: refs/heads/feature')
        await rename(entryHeadLock, entryHead)

        await vi.advanceTimersByTimeAsync(POLL_MS * RECONCILIATION_TICKS)
        await vi.waitFor(
          () => {
            expect(received.flat()).toContainEqual({ type: 'update', path: entryHead })
          },
          { timeout: 2_000 }
        )
      } finally {
        await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
        restorePerformanceNow.mockRestore()
        vi.useRealTimers()
      }
    })

    it('detects a linked worktree added and removed out-of-band on the regular cadence', async () => {
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
})
