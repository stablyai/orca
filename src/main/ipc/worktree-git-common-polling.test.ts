import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { startGitCommonPolling } from './worktree-git-common-polling'
import type {
  WorktreeBasePollEvent,
  WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'

// Why: measure the fan-out this poller issues per scan (peak concurrent `stat`
// calls, `readdir` call count as a proxy for "a scan started") without
// depending on real disk timing (#17828). `entryZeroHeadStatCalls` tracks stats
// on a specific pre-existing entry's HEAD file, which only a per-entry sweep
// (not the cheap structural tripwire) re-reads.
const { statDelayMs, readdirCalls, concurrency, entryZeroHeadStatCalls } = vi.hoisted(() => ({
  statDelayMs: { current: 0 },
  readdirCalls: { count: 0 },
  concurrency: { current: 0, peak: 0 },
  entryZeroHeadStatCalls: { count: 0 }
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
      if (typeof path === 'string' && path.endsWith(`wt-0${sep}HEAD`)) {
        entryZeroHeadStatCalls.count += 1
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
    entryZeroHeadStatCalls.count = 0
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

  it('stretches only the per-entry sweep cadence, keeping the structural tripwire on pollIntervalMs', async () => {
    const commonDir = await makeCommonDir(2)
    dirsToRemove.push(commonDir)
    statDelayMs.current = 60
    const baseIntervalMs = 20
    const sub = await startGitCommonPolling(
      commonDir,
      () => {},
      baseIntervalMs,
      alwaysVisible,
      undefined,
      true,
      () => [],
      { adaptiveCadence: true }
    )
    cleanups.push(() => sub.unsubscribe())

    // Let the bootstrap snapshot's own (unconditional) sweep settle, then measure.
    await new Promise((resolve) => setTimeout(resolve, baseIntervalMs * 2))
    readdirCalls.count = 0
    entryZeroHeadStatCalls.count = 0
    // A scan several times slower than the 20ms base interval stretches the sweep's
    // own cadence, but the cheap readdir/dir-signature tripwire must keep firing
    // every ~baseIntervalMs regardless — worktree add/remove and HEAD must not
    // inherit the sweep's stretch (#17828 follow-up: staleness trade-off).
    await vi.waitFor(
      () => {
        expect(readdirCalls.count).toBeGreaterThan(3)
      },
      { timeout: 2_000 }
    )
    // wt-0 already existed at bootstrap, so a tripwire-only tick must carry its
    // entry over rather than re-stat it; far fewer sweeps than tripwire ticks ran.
    expect(entryZeroHeadStatCalls.count).toBeLessThan(readdirCalls.count)
  })

  it('does not stretch cadence for callers that opt out of adaptive cadence', async () => {
    const commonDir = await makeCommonDir(2)
    dirsToRemove.push(commonDir)
    statDelayMs.current = 0
    const pollIntervalMs = 20
    const sub = await startGitCommonPolling(commonDir, () => {}, pollIntervalMs, alwaysVisible)
    cleanups.push(() => sub.unsubscribe())

    readdirCalls.count = 0
    // Fixed cadence: several scans should land within a handful of intervals.
    await vi.waitFor(
      () => {
        expect(readdirCalls.count).toBeGreaterThanOrEqual(2)
      },
      { timeout: 2_000 }
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
