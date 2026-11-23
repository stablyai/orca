import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repository/repo-types'
import type { WorktreeCatalogOutcome } from './repo-worktree-catalog-observation'
import {
  invalidateWorktreeCatalogForRepo,
  readWorktreeCatalog
} from './repo-worktree-catalog-owner'
import { onWorktreeCatalogRevalidated } from './repo-worktree-catalog-freshness'

const repo: Repo = {
  id: 'freshness-repo',
  path: '/repos/freshness',
  displayName: 'freshness',
  badgeColor: 'blue',
  addedAt: 0,
  kind: 'git'
}

function controlledScans() {
  const pending: ((outcome: WorktreeCatalogOutcome) => void)[] = []
  const plan = {
    scan: () => new Promise<WorktreeCatalogOutcome>((resolve) => pending.push(resolve))
  }
  const finish = async (path: string, atMs: number) => {
    vi.setSystemTime(atMs)
    pending.shift()!({
      kind: 'rows',
      worktrees: [
        { path, head: 'a', branch: 'refs/heads/main', isBare: false, isMainWorktree: true }
      ]
    })
    await Promise.resolve()
  }
  return { plan, pending, finish }
}

const read = (plan: ReturnType<typeof controlledScans>['plan']) =>
  readWorktreeCatalog(
    repo,
    'local:default',
    {
      kind: 'desktop',
      maxAgeMs: 5_000,
      staleWhileRevalidate: { minScanMs: 1_000, maxStaleMs: 300_000 }
    },
    plan
  )

describe('worktree catalog freshness', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    invalidateWorktreeCatalogForRepo(repo.id)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('serves rows from a scan slower than the window, then revalidates aged rows once without waiting', async () => {
    const scans = controlledScans()
    const notified: string[] = []
    const stopListening = onWorktreeCatalogRevalidated((repoId) => notified.push(repoId))
    const first = read(scans.plan)
    await vi.waitFor(() => expect(scans.pending).toHaveLength(1))
    await scans.finish('/repos/freshness/v1', 6_000)
    const published = (await first).observation

    // Window runs from completion: a 6 s scan is still fresh 4 s after it ends.
    vi.setSystemTime(10_000)
    expect((await read(scans.plan)).observation).toBe(published)
    expect(scans.pending).toHaveLength(0)

    // Aged rows answer at once while exactly one background scan refreshes them.
    vi.setSystemTime(20_000)
    const stale = await read(scans.plan)
    expect(stale).toEqual({ observation: published, superseded: false, stale: true })
    expect((await read(scans.plan)).observation).toBe(published)
    expect(scans.pending).toHaveLength(1)
    await scans.finish('/repos/freshness/v2', 26_000)
    const refreshed = (await read(scans.plan)).observation
    expect(refreshed?.outcome).toMatchObject({ worktrees: [{ path: '/repos/freshness/v2' }] })
    expect(notified).toEqual([repo.id])

    // A mutation overtakes the published rows: readers wait for truth instead of serving them.
    invalidateWorktreeCatalogForRepo(repo.id)
    let settled = false
    const afterMutation = read(scans.plan).then((result) => {
      settled = true
      return result
    })
    await vi.waitFor(() => expect(scans.pending).toHaveLength(1))
    expect(settled).toBe(false)
    await scans.finish('/repos/freshness/v3', 27_000)
    expect((await afterMutation).observation?.outcome).toMatchObject({
      worktrees: [{ path: '/repos/freshness/v3' }]
    })
    expect(notified).toEqual([repo.id])

    // A scan another reader started still tells readers that were served stale rows.
    vi.setSystemTime(40_000)
    const strict = readWorktreeCatalog(
      repo,
      'local:default',
      { kind: 'runtime', maxAgeMs: 0 },
      scans.plan
    )
    await vi.waitFor(() => expect(scans.pending).toHaveLength(1))
    expect((await read(scans.plan)).stale).toBe(true)
    expect(scans.pending).toHaveLength(1)
    await scans.finish('/repos/freshness/v4', 45_000)
    await strict
    expect(notified).toEqual([repo.id, repo.id])
    stopListening()
  })
})
