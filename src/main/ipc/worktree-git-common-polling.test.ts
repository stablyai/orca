import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { startGitCommonPolling } from './worktree-git-common-polling'
import type {
  WorktreeBasePollEvent,
  WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'

// Why: measure the fan-out this poller issues per scan (peak concurrent `stat`
// calls, `readdir` call count as a proxy for "a tick ran") without depending on
// real disk timing (#17828). `entryZeroStatCalls` tracks every stat under a
// specific pre-existing entry (its dir plus every leaf), used to prove the
// entry-dir signature gate keeps an unchanged entry to one stat per tick.
const { statDelayMs, readdirCalls, concurrency, entryZeroStatCalls } = vi.hoisted(() => ({
  statDelayMs: { current: 0 },
  readdirCalls: { count: 0 },
  concurrency: { current: 0, peak: 0 },
  entryZeroStatCalls: { count: 0 }
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    readdir: (...args: Parameters<typeof actual.readdir>) => {
      readdirCalls.count += 1
      return actual.readdir(...args)
    },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      concurrency.current += 1
      concurrency.peak = Math.max(concurrency.peak, concurrency.current)
      const path = args[0]
      const entryZeroSegment = `${sep}wt-0`
      if (
        typeof path === 'string' &&
        (path.endsWith(entryZeroSegment) || path.includes(`${entryZeroSegment}${sep}`))
      ) {
        entryZeroStatCalls.count += 1
      }
      try {
        if (statDelayMs.current > 0) {
          await new Promise((resolve) => setTimeout(resolve, statDelayMs.current))
        }
        return await actual.stat(...args)
      } finally {
        concurrency.current -= 1
      }
    }
  }
})

const alwaysVisible: WorktreePollerWindowVisibility = {
  isWindowVisible: () => true,
  onWindowBecameVisible: () => () => {}
}

async function makeCommonDir(entryCount: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'git-common-polling-test-'))
  for (let i = 0; i < entryCount; i++) {
    const entryPath = join(root, 'worktrees', `wt-${i}`)
    await mkdir(join(entryPath, 'logs'), { recursive: true })
    await Promise.all([
      writeFile(join(entryPath, 'HEAD'), 'ref: refs/heads/main\n'),
      writeFile(join(entryPath, 'gitdir'), `${join(root, `checkout-${i}`, '.git')}\n`),
      writeFile(join(entryPath, 'index'), Buffer.from([0])),
      writeFile(join(entryPath, 'logs', 'HEAD'), '0000 aaaa\n')
    ])
  }
  return root
}

describe('startGitCommonPolling fan-out bounds (#17828)', () => {
  const cleanups: (() => Promise<void>)[] = []
  const dirsToRemove: string[] = []

  beforeEach(() => {
    statDelayMs.current = 0
    readdirCalls.count = 0
    concurrency.current = 0
    concurrency.peak = 0
    entryZeroStatCalls.count = 0
  })

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
    await Promise.all(
      dirsToRemove.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    )
    vi.useRealTimers()
  })

  it('bounds concurrent per-entry stat fan-out regardless of entry count', async () => {
    const commonDir = await makeCommonDir(200)
    dirsToRemove.push(commonDir)
    const sub = await startGitCommonPolling(commonDir, () => {}, 100_000, alwaysVisible)
    cleanups.push(() => sub.unsubscribe())
    // 200 entries x ~6 concurrent structural stats each would peak near 1,200
    // unbounded; bounding to 8 in-flight entries keeps the peak independent of
    // entry count instead of scaling with it.
    expect(concurrency.peak).toBeLessThan(80)
  })

  it('never overlaps a scan with itself even when ticks fire faster than a scan completes', async () => {
    const commonDir = await makeCommonDir(10)
    dirsToRemove.push(commonDir)
    statDelayMs.current = 20
    const pollIntervalMs = 5
    const sub = await startGitCommonPolling(commonDir, () => {}, pollIntervalMs, alwaysVisible)
    cleanups.push(() => sub.unsubscribe())
    readdirCalls.count = 0
    // ~60 would-be 5ms ticks elapse in this window while every stat takes 20ms;
    // the ticking guard must serialize scans, not launch overlapping ones.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(readdirCalls.count).toBeLessThan(10)
  })

  it('costs exactly one stat per tick for an unchanged entry', async () => {
    const commonDir = await makeCommonDir(1)
    dirsToRemove.push(commonDir)
    const pollIntervalMs = 20
    const sub = await startGitCommonPolling(commonDir, () => {}, pollIntervalMs, alwaysVisible)
    cleanups.push(() => sub.unsubscribe())

    // Let the bootstrap snapshot (which always fully reads every entry once) settle.
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    readdirCalls.count = 0
    entryZeroStatCalls.count = 0
    await vi.waitFor(
      () => {
        expect(readdirCalls.count).toBeGreaterThanOrEqual(5)
      },
      { timeout: 2_000 }
    )
    // Without the entry-dir signature gate, an unchanged entry still costs ~6
    // stats every tick (HEAD/gitdir/locked/config.worktree/logs/HEAD/index).
    // With the gate, only the entry dir itself is stat'd once nothing changed —
    // one stat per tick, in lockstep with the readdir tripwire.
    expect(entryZeroStatCalls.count).toBeLessThanOrEqual(readdirCalls.count + 1)
    expect(entryZeroStatCalls.count).toBeGreaterThanOrEqual(readdirCalls.count - 1)
  })

  it('detects a HEAD rewrite via lock+rename on the next tick', async () => {
    const commonDir = await makeCommonDir(1)
    dirsToRemove.push(commonDir)
    const events: WorktreeBasePollEvent[][] = []
    const pollIntervalMs = 20
    const sub = await startGitCommonPolling(
      commonDir,
      (batch) => events.push(batch),
      pollIntervalMs,
      alwaysVisible
    )
    cleanups.push(() => sub.unsubscribe())
    // Let the bootstrap snapshot settle before mutating.
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))

    const entryDir = join(commonDir, 'worktrees', 'wt-0')
    const headPath = join(entryDir, 'HEAD')
    const headLockPath = join(entryDir, 'HEAD.lock')
    // Every real git ref write goes through a lock file + rename inside the entry
    // dir (never an in-place overwrite), which moves the entry dir's own signature.
    await writeFile(headLockPath, 'ref: refs/heads/feature\n')
    await rename(headLockPath, headPath)

    await vi.waitFor(
      () => {
        expect(events.flat()).toContainEqual({ type: 'update', path: headPath })
      },
      { timeout: pollIntervalMs * 10 }
    )
  })

  it('detects an in-place gitdir rewrite only once the periodic backstop rescans it', async () => {
    const commonDir = await makeCommonDir(1)
    dirsToRemove.push(commonDir)
    const events: WorktreeBasePollEvent[][] = []
    const pollIntervalMs = 10
    const sub = await startGitCommonPolling(
      commonDir,
      (batch) => events.push(batch),
      pollIntervalMs,
      alwaysVisible
    )
    cleanups.push(() => sub.unsubscribe())
    // Let the bootstrap snapshot settle before mutating.
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))

    const entryDir = join(commonDir, 'worktrees', 'wt-0')
    const gitdirPath = join(entryDir, 'gitdir')
    // `gitdir` is the one structural leaf git rewrites in place (worktree move/repair),
    // so the entry dir's own signature never moves — the periodic ungated backstop
    // (INDEX_BACKSTOP_TICKS = 15) is the only thing that catches it.
    await writeFile(gitdirPath, `${join(commonDir, 'checkout-moved', '.git')}\n`)

    // Not caught by the next several ticks: the gate stays closed since nothing
    // moved the entry dir's own signature.
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs * 5))
    expect(events.flat()).not.toContainEqual({ type: 'update', path: gitdirPath })

    // Eventually caught regardless of the gate, once tick 15 forces the periodic backstop.
    await vi.waitFor(
      () => {
        expect(events.flat()).toContainEqual({ type: 'update', path: gitdirPath })
      },
      { timeout: pollIntervalMs * 40 }
    )
  })

  it('still detects entry add/remove correctly with bounded concurrency', async () => {
    const commonDir = await makeCommonDir(5)
    dirsToRemove.push(commonDir)
    const events: WorktreeBasePollEvent[][] = []
    const sub = await startGitCommonPolling(
      commonDir,
      (batch) => events.push(batch),
      20,
      alwaysVisible
    )
    cleanups.push(() => sub.unsubscribe())

    const newEntry = join(commonDir, 'worktrees', 'wt-new')
    await mkdir(join(newEntry, 'logs'), { recursive: true })
    await writeFile(join(newEntry, 'HEAD'), 'ref: refs/heads/main\n')

    await vi.waitFor(() => {
      expect(events.flat()).toContainEqual({ type: 'create', path: newEntry })
    })

    await rm(newEntry, { recursive: true })
    await vi.waitFor(() => {
      expect(events.flat()).toContainEqual({ type: 'delete', path: newEntry })
    })
  })
})

const POLL_MS = 25

// Regression coverage for a bug where `shouldSweep` gated the ENTIRE tick body,
// including a forced (visibility-resume / requestEarlyTick) call — silently
// dropping the leaf re-read that callers of a forced tick depend on. `tick`'s
// `forceFullScan ||` short-circuit fixes this; this test pins that guarantee
// directly against startGitCommonPolling, independent of any current caller.
describe('git-common polling: forced ticks always sweep', () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  })

  async function makeForcedTickCommonDir(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'orca-git-common-polling-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    return realpath(root)
  }

  it('a visibility-resume forced tick sweeps even when shouldSweep says skip', async () => {
    vi.useFakeTimers()
    try {
      const commonDir = await makeForcedTickCommonDir()
      const worktreesDir = join(commonDir, 'worktrees')
      await mkdir(worktreesDir)
      await mkdir(join(worktreesDir, 'wt-1'))
      await writeFile(join(worktreesDir, 'wt-1', 'HEAD'), 'ref: refs/heads/main')

      let visible = true
      // Why: a plain `let` reassigned from inside this closure and read
      // outside it narrows to `never` under TS's control-flow analysis; a
      // holder object sidesteps that.
      const visibilityListener: { current: (() => void) | null } = { current: null }
      const visibility: WorktreePollerWindowVisibility = {
        isWindowVisible: () => visible,
        onWindowBecameVisible: (listener) => {
          visibilityListener.current = listener
          return () => {
            visibilityListener.current = null
          }
        }
      }
      const onFullScan = vi.fn()

      const subscription = await startGitCommonPolling(
        commonDir,
        () => {},
        POLL_MS,
        visibility,
        onFullScan,
        false,
        () => [],
        { shouldSweep: () => false }
      )
      cleanups.push(() => subscription.unsubscribe())
      onFullScan.mockClear()

      // Park the poller while hidden, then resume: the resume path calls
      // tick(true) specifically to force a leaf re-read of what happened
      // while parked, despite shouldSweep saying skip on every other tick.
      visible = false
      await vi.advanceTimersByTimeAsync(POLL_MS)
      visible = true
      visibilityListener.current?.()

      await vi.waitFor(
        () => {
          expect(onFullScan).toHaveBeenCalled()
        },
        { timeout: 1_000 }
      )
    } finally {
      vi.useRealTimers()
    }
  })
})

// Coverage for requestEarlyTick itself: the primitive notifyLossSignal calls
// to react to a watcher loss signal sooner than the regular cadence, without
// letting a burst of signals drive the fan-out as fast as the burst arrives.
describe('git-common polling: requestEarlyTick', () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  })

  async function makeEarlyTickCommonDir(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'orca-git-common-early-tick-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const commonDir = await realpath(root)
    await mkdir(join(commonDir, 'worktrees'))
    return commonDir
  }

  const alwaysVisibleForEarlyTick: WorktreePollerWindowVisibility = {
    isWindowVisible: () => true,
    onWindowBecameVisible: () => () => {}
  }

  it('fires well before the next regular tick, bounded by earlyTickMinIntervalMs', async () => {
    vi.useFakeTimers()
    try {
      const commonDir = await makeEarlyTickCommonDir()
      const onFullScan = vi.fn()
      const EARLY_FLOOR_MS = 50
      const REGULAR_CADENCE_MS = 1_000
      const subscription = await startGitCommonPolling(
        commonDir,
        () => {},
        REGULAR_CADENCE_MS,
        alwaysVisibleForEarlyTick,
        onFullScan,
        false,
        () => [],
        { forceFullScanEveryTick: true, earlyTickMinIntervalMs: EARLY_FLOOR_MS }
      )
      cleanups.push(() => subscription.unsubscribe())

      // Let the first regular tick land so lastTickStartedAt reflects a real,
      // recent tick rather than construction time.
      await vi.waitFor(() => expect(onFullScan).toHaveBeenCalledTimes(1), { timeout: 2_000 })
      onFullScan.mockClear()

      subscription.requestEarlyTick()
      // Well under REGULAR_CADENCE_MS: if this only landed at the next
      // scheduled tick, the "early" tick isn't actually accelerating anything.
      await vi.waitFor(() => expect(onFullScan).toHaveBeenCalledTimes(1), { timeout: 500 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds a storm of requestEarlyTick calls to a handful of ticks, not one per call', async () => {
    vi.useFakeTimers()
    try {
      const commonDir = await makeEarlyTickCommonDir()
      const onFullScan = vi.fn()
      const EARLY_FLOOR_MS = 50
      const subscription = await startGitCommonPolling(
        commonDir,
        () => {},
        10_000, // long regular cadence: it must not fire on its own during this test
        alwaysVisibleForEarlyTick,
        onFullScan,
        false,
        () => [],
        { forceFullScanEveryTick: true, earlyTickMinIntervalMs: EARLY_FLOOR_MS }
      )
      cleanups.push(() => subscription.unsubscribe())

      // A wedged watcher child emitting overflow continuously, faster than
      // the early-tick floor: 50 calls, 5ms apart (250ms of storm).
      const STORM_CALLS = 50
      const STORM_INTERVAL_MS = 5
      for (let i = 0; i < STORM_CALLS; i++) {
        subscription.requestEarlyTick()
        await vi.advanceTimersByTimeAsync(STORM_INTERVAL_MS)
      }
      // Let any trailing coalesced early tick actually settle.
      await vi.waitFor(() => expect(onFullScan.mock.calls.length).toBeGreaterThan(0), {
        timeout: 500
      })

      const stormDurationMs = STORM_CALLS * STORM_INTERVAL_MS
      // ⌈stormDuration / floor⌉, plus a little slack for the boundary/trailing tick.
      const maxExpectedTicks = Math.ceil(stormDurationMs / EARLY_FLOOR_MS) + 2
      expect(onFullScan.mock.calls.length).toBeLessThanOrEqual(maxExpectedTicks)
      expect(onFullScan.mock.calls.length).toBeLessThan(STORM_CALLS)
    } finally {
      vi.useRealTimers()
    }
  })
})
