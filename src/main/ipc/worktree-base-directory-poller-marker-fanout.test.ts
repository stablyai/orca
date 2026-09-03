import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorktreeBaseDirectoryPoller } from './worktree-base-directory-poller'
import type {
  WorktreeBaseRepoWatchConfig,
  WorktreeBaseWatchTarget
} from './worktree-base-directory-event-filter'

// Why: the backstop full scan stats a `.git` marker per candidate dir; an
// unbounded fan-out at hundreds of worktrees would queue thousands of `stat`
// calls on libuv's 4-thread pool (#17828).
const { concurrency } = vi.hoisted(() => ({ concurrency: { current: 0, peak: 0 } }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      concurrency.current += 1
      concurrency.peak = Math.max(concurrency.peak, concurrency.current)
      try {
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
  })

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  })

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
})
