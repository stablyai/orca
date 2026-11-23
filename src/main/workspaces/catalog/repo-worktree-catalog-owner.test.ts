import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repository/repo-types'
import type { WorktreeCatalogOutcome } from './repo-worktree-catalog-observation'
import {
  invalidateWorktreeCatalogForRepo,
  readWorktreeCatalog
} from './repo-worktree-catalog-owner'

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
  const fail = async (atMs: number) => {
    vi.setSystemTime(atMs)
    pending.shift()!({ kind: 'failed', error: new Error('worktree list failed') })
    await Promise.resolve()
  }
  return { plan, pending, finish, fail }
}

const read = (plan: ReturnType<typeof controlledScans>['plan']) =>
  readWorktreeCatalog(repo, 'local:default', { kind: 'desktop', maxAgeMs: 5_000 }, plan)

describe('worktree catalog freshness', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    invalidateWorktreeCatalogForRepo(repo.id)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('times the freshness window from scan completion, and a mutation still forces a rescan', async () => {
    const scans = controlledScans()
    const first = read(scans.plan)
    await vi.waitFor(() => expect(scans.pending).toHaveLength(1))
    await scans.finish('/repos/freshness/v1', 6_000)
    const published = (await first).observation

    // A 6 s scan is still fresh 4 s after it ends; timed from its start it would already be stale.
    vi.setSystemTime(10_000)
    expect((await read(scans.plan)).observation).toBe(published)
    expect(scans.pending).toHaveLength(0)

    // Past the window from completion, readers share one rescan.
    vi.setSystemTime(12_000)
    const late = read(scans.plan)
    const joined = read(scans.plan)
    await vi.waitFor(() => expect(scans.pending).toHaveLength(1))
    await scans.finish('/repos/freshness/v2', 13_000)
    expect((await late).observation).toBe((await joined).observation)
    expect((await late).observation?.outcome).toMatchObject({
      worktrees: [{ path: '/repos/freshness/v2' }]
    })

    // A mutation overtakes fresh rows: readers wait for a new scan instead of reusing them.
    invalidateWorktreeCatalogForRepo(repo.id)
    const afterMutation = read(scans.plan)
    await vi.waitFor(() => expect(scans.pending).toHaveLength(1))
    await scans.finish('/repos/freshness/v3', 14_000)
    expect((await afterMutation).observation?.outcome).toMatchObject({
      worktrees: [{ path: '/repos/freshness/v3' }]
    })
  })

  it('reuses a slow failed scan for its window from completion instead of retrying it at once', async () => {
    const scans = controlledScans()
    const runtimeRead = () =>
      readWorktreeCatalog(
        repo,
        'local:default',
        { kind: 'runtime', maxAgeMs: 5_000, reusesFailure: true },
        scans.plan
      )
    const first = runtimeRead()
    await vi.waitFor(() => expect(scans.pending).toHaveLength(1))
    await scans.fail(6_000)
    const failed = (await first).observation
    expect(failed?.outcome.kind).toBe('failed')

    vi.setSystemTime(10_000)
    expect((await runtimeRead()).observation).toBe(failed)
    expect(scans.pending).toHaveLength(0)
  })
})
