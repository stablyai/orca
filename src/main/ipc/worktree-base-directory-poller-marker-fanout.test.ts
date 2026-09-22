import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MARKER_PROBE_CONCURRENCY } from './worktree-base-directory-marker-poller'
import { startWorktreeBaseDirectoryPoller } from './worktree-base-directory-poller'
import type {
  WorktreeBaseRepoWatchConfig,
  WorktreeBaseWatchTarget
} from './worktree-base-directory-event-filter'

// Why: the backstop full scan stats a `.git` marker per candidate dir; an
// unbounded fan-out at hundreds of worktrees would queue thousands of `stat`
// calls on libuv's 4-thread pool (#17828).
const { concurrency, markerStatGate } = vi.hoisted(() => ({
  concurrency: { current: 0, peak: 0 },
  // Parks `.git` stats so a batch's launched-at-once width is observable without wall clocks.
  markerStatGate: { hold: false, parked: [] as (() => void)[] }
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      concurrency.current += 1
      concurrency.peak = Math.max(concurrency.peak, concurrency.current)
      try {
        if (markerStatGate.hold && String(args[0]).endsWith('.git')) {
          await new Promise<void>((resolve) => markerStatGate.parked.push(resolve))
        }
        return await actual.stat(...args)
      } finally {
        concurrency.current -= 1
      }
    }
  }
})

function makeTarget(path: string): WorktreeBaseWatchTarget {
  const repoConfig: WorktreeBaseRepoWatchConfig = {
    repoId: 'repo-1',
    repoName: 'project',
    nestWorkspaces: false
  }
  return {
    key: `base:local:${path}`,
    kind: 'base',
    path,
    repos: new Map([[repoConfig.repoId, repoConfig]])
  }
}

describe('worktree base directory poller marker fan-out (#17828)', () => {
  const cleanups: (() => Promise<void>)[] = []

  beforeEach(() => {
    concurrency.current = 0
    concurrency.peak = 0
    markerStatGate.hold = false
    markerStatGate.parked.length = 0
  })

  afterEach(async () => {
    markerStatGate.hold = false
    for (const resume of markerStatGate.parked.splice(0)) {
      resume()
    }
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  })

  async function waitUntil(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 2_000 && !predicate(); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    if (!predicate()) {
      throw new Error('timed out waiting for the poller')
    }
  }

  it('bounds concurrent `.git`-marker stats regardless of candidate count', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-base-poller-fanout-')))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const candidateCount = 200
    for (let i = 0; i < candidateCount; i++) {
      const worktree = join(root, `wt-${i}`)
      await mkdir(worktree)
      await writeFile(join(worktree, '.git'), 'gitdir: elsewhere')
    }

    const target = makeTarget(root)
    const poller = await startWorktreeBaseDirectoryPoller(
      target,
      () => target.repos,
      () => {},
      { pollIntervalMs: 100_000 }
    )
    cleanups.push(() => poller.unsubscribe())

    // 200 candidates stated unbounded would peak near 200 concurrent `stat`
    // calls; bounding the marker probe keeps the peak independent of count —
    // while still overlapping requests (not serialized one-at-a-time).
    expect(concurrency.peak).toBeGreaterThan(1)
    expect(concurrency.peak).toBeLessThan(20)
  })

  it('probes pending `.git` markers in bounded batches instead of one at a time', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-base-poller-pending-')))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const pendingCount = MARKER_PROBE_CONCURRENCY * 4
    for (let i = 0; i < pendingCount; i++) {
      // No `.git`: every dir stays a pending-marker candidate for the whole test.
      await mkdir(join(root, `pending-${i}`))
    }

    const probed: string[] = []
    let parkFirstBatch = true
    const target = makeTarget(root)
    const poller = await startWorktreeBaseDirectoryPoller(
      target,
      () => target.repos,
      () => {},
      {
        pollIntervalMs: 1,
        onPendingMarkerProbe: (path) => {
          probed.push(path)
          // Park from the first probe onward, so the count below is the batch width.
          markerStatGate.hold = parkFirstBatch
        }
      }
    )
    cleanups.push(() => poller.unsubscribe())

    await waitUntil(() => markerStatGate.parked.length > 0)

    // Serial probing parks after one; the batch launches exactly the bound at once.
    expect(probed.length).toBe(MARKER_PROBE_CONCURRENCY)

    parkFirstBatch = false
    markerStatGate.hold = false
    for (const resume of markerStatGate.parked.splice(0)) {
      resume()
    }
    await waitUntil(() => probed.length >= pendingCount)

    // The first tick still probes every due dir exactly once.
    expect(new Set(probed.slice(0, pendingCount)).size).toBe(pendingCount)
  })
})
