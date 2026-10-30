import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdir, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { startGitCommonPolling } from './worktree-git-common-polling'
import type {
  WorktreeBasePollEvent,
  WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'

// Measure per-tick fanout with stat/readdir hooks; unchanged entries should need only one directory stat.
type StatHook = { current: ((path: unknown) => Promise<void>) | null }
const { statDelayMs, statHook, readdirCalls, concurrency, entryZeroStatCalls } = vi.hoisted(() => {
  const statHook: StatHook = { current: null }
  return {
    statDelayMs: { current: 0 },
    statHook,
    readdirCalls: { count: 0 },
    concurrency: { current: 0, peak: 0 },
    entryZeroStatCalls: { count: 0 }
  }
})

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
        await statHook.current?.(path)
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
    // Slow stats must serialize ticks rather than launching overlapping scans.
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
    // Unchanged entry stats should track ticks, not the number of structural leaves.
    expect(entryZeroStatCalls.count).toBeLessThanOrEqual(readdirCalls.count + 1)
    expect(entryZeroStatCalls.count).toBeGreaterThanOrEqual(readdirCalls.count - 1)
  })

  it('detects a HEAD rewrite via lock+rename on the next tick', async () => {
    const commonDir = await makeCommonDir(1)
    dirsToRemove.push(commonDir)
    const entryDir = join(commonDir, 'worktrees', 'wt-0')
    // Ensure rename changes the directory signature even on coarse-mtime filesystems.
    await utimes(entryDir, new Date(0), new Date(0))
    const received = Promise.withResolvers<WorktreeBasePollEvent[]>()
    const pollIntervalMs = 20
    vi.useFakeTimers()
    const sub = await startGitCommonPolling(
      commonDir,
      received.resolve,
      pollIntervalMs,
      alwaysVisible
    )
    cleanups.push(() => sub.unsubscribe())

    const headPath = join(entryDir, 'HEAD')
    const headLockPath = join(entryDir, 'HEAD.lock')
    await writeFile(headLockPath, 'ref: refs/heads/feature\n')
    await rename(headLockPath, headPath)

    readdirCalls.count = 0
    await vi.advanceTimersByTimeAsync(pollIntervalMs)
    expect(await received.promise).toContainEqual({ type: 'update', path: headPath })
    expect(readdirCalls.count).toBe(1)
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
    // In-place gitdir repair bypasses directory signatures; only the periodic ungated backstop detects it.
    await writeFile(gitdirPath, `${join(commonDir, 'checkout-moved', '.git')}\n`)

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs * 5))
    expect(events.flat()).not.toContainEqual({ type: 'update', path: gitdirPath })

    await vi.waitFor(
      () => {
        expect(events.flat()).toContainEqual({ type: 'update', path: gitdirPath })
      },
      { timeout: pollIntervalMs * 40 }
    )
  })

  it.each([{}, { reconciliationFullScanEveryTicks: 1_000 }])(
    'still detects entry add/remove correctly with bounded concurrency (%o)',
    async (options) => {
      const commonDir = await makeCommonDir(5)
      dirsToRemove.push(commonDir)
      const events: WorktreeBasePollEvent[][] = []
      const sub = await startGitCommonPolling(
        commonDir,
        (batch) => events.push(batch),
        20,
        alwaysVisible,
        undefined,
        true,
        () => [],
        options
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
    }
  )
})

describe('startGitCommonPolling reconciliation mode', () => {
  const cleanups: (() => Promise<void>)[] = []
  const dirsToRemove: string[] = []
  const pollIntervalMs = 10

  beforeEach(() => {
    readdirCalls.count = 0
    entryZeroStatCalls.count = 0
  })

  afterEach(async () => {
    statHook.current = null
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
    await Promise.all(
      dirsToRemove.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    )
  })

  async function expectFullScanEveryTick(onFullScan: ReturnType<typeof vi.fn>, expected: boolean) {
    readdirCalls.count = 0
    onFullScan.mockClear()
    await vi.waitFor(() => expect(readdirCalls.count).toBeGreaterThanOrEqual(5), {
      timeout: 2_000
    })
    if (expected) {
      expect(onFullScan.mock.calls.length).toBeGreaterThanOrEqual(readdirCalls.count - 1)
    } else {
      expect(onFullScan).not.toHaveBeenCalled()
    }
  }

  async function startReconciliation(fullScanEveryTicks: number) {
    const commonDir = await makeCommonDir(1)
    dirsToRemove.push(commonDir)
    const events: WorktreeBasePollEvent[][] = []
    const onFullScan = vi.fn()
    const sub = await startGitCommonPolling(
      commonDir,
      (batch) => events.push(batch),
      pollIntervalMs,
      alwaysVisible,
      onFullScan,
      false,
      () => [],
      { reconciliationFullScanEveryTicks: fullScanEveryTicks }
    )
    cleanups.push(() => sub.unsubscribe())
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    return { entryDir: join(commonDir, 'worktrees', 'wt-0'), events, onFullScan }
  }

  it('stats only the entry dir and its in-place leaves for an unchanged entry', async () => {
    const { onFullScan } = await startReconciliation(1_000)
    readdirCalls.count = 0
    entryZeroStatCalls.count = 0
    await vi.waitFor(() => expect(readdirCalls.count).toBeGreaterThanOrEqual(5), {
      timeout: 2_000
    })
    // dir + gitdir + logs/HEAD per tick, versus 7 for an ungated sweep.
    const ticks = readdirCalls.count
    expect(entryZeroStatCalls.count).toBeLessThanOrEqual((ticks + 1) * 3)
    expect(entryZeroStatCalls.count).toBeGreaterThanOrEqual((ticks - 1) * 3)
    expect(onFullScan).not.toHaveBeenCalled()
  })

  it.each([
    ['gitdir', (entryDir: string) => writeFile(join(entryDir, 'gitdir'), '/moved/.git\n')],
    ['logs/HEAD', (entryDir: string) => appendFile(join(entryDir, 'logs', 'HEAD'), '1111 bbbb\n')]
  ])('detects an in-place %s write before the full sweep', async (leaf, write) => {
    const { entryDir, events, onFullScan } = await startReconciliation(1_000)
    await write(entryDir)
    await vi.waitFor(() =>
      expect(events.flat()).toContainEqual({ type: 'update', path: join(entryDir, leaf) })
    )
    expect(onFullScan).not.toHaveBeenCalled()
  })

  it('runs the ungated sweep periodically', async () => {
    const { onFullScan } = await startReconciliation(4)
    await vi.waitFor(() => expect(onFullScan).toHaveBeenCalled(), { timeout: 2_000 })
    readdirCalls.count = 0
    onFullScan.mockClear()
    await vi.waitFor(() => expect(readdirCalls.count).toBeGreaterThanOrEqual(8), {
      timeout: 2_000
    })
    expect(onFullScan.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(onFullScan.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('sweeps every tick once leaf-triggered rescans twice find a change the dir missed', async () => {
    const { entryDir, events, onFullScan } = await startReconciliation(1_000)
    const indexPath = join(entryDir, 'index')
    // In-place index + reflog writes mimic a commit on a dir-mtime-blind filesystem.
    for (const [round, bytes] of [
      [1, [1]],
      [2, [2, 3]]
    ] as const) {
      await writeFile(indexPath, Buffer.from(bytes))
      await appendFile(join(entryDir, 'logs', 'HEAD'), `${round}\n`)
      await vi.waitFor(
        () => expect(events.flat().filter((event) => event.path === indexPath)).toHaveLength(round),
        { timeout: 2_000 }
      )
    }
    await expectFullScanEveryTick(onFullScan, true)
  })

  it('keeps the dir gate when a rename races the leaf stats', async () => {
    const { entryDir, events, onFullScan } = await startReconciliation(1_000)
    const headPath = join(entryDir, 'HEAD')
    for (const round of [1, 2, 3]) {
      let raced = false
      // Land a lock+rename after the dir stat but before the leaf stats see HEAD.
      statHook.current = async (path) => {
        if (path === headPath && !raced) {
          raced = true
          await writeFile(`${headPath}.lock`, `ref: refs/heads/race-${round}\n`)
          await rename(`${headPath}.lock`, headPath)
        }
      }
      await appendFile(join(entryDir, 'logs', 'HEAD'), `${round}\n`)
      await vi.waitFor(
        () => expect(events.flat().filter((event) => event.path === headPath)).toHaveLength(round),
        { timeout: 2_000 }
      )
    }
    statHook.current = null
    await expectFullScanEveryTick(onFullScan, false)
  })
})
