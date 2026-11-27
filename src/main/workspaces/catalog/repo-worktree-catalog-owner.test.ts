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
  return { plan, pending, finish }
}

// Each case owns its repo: the fake clock restarts at 0, and an older test's newer rows would mask it.
const repoFor = (id: string): Repo => ({ ...repo, id, path: `/repos/${id}` })

const read = (plan: ReturnType<typeof controlledScans>['plan'], target: Repo = repo) =>
  readWorktreeCatalog(target, 'local:default', { kind: 'desktop', maxAgeMs: 5_000 }, plan)

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

  it('never lets completion-timed reuse outlive the verifier ceiling measured from scan start', async () => {
    const scans = controlledScans()
    const target = repoFor('ceiling')
    const first = read(scans.plan, target)
    await vi.waitFor(() => expect(scans.pending).toHaveLength(1))
    await scans.finish('/repos/freshness/v1', 6_000)
    await first

    // Fresh by the window (3 s after completion) but past the ceiling from scan start.
    vi.setSystemTime(9_000)
    const verified = readWorktreeCatalog(
      target,
      'local:default',
      {
        kind: 'runtime',
        maxAgeMs: 5_000,
        verifier: { ceilingMs: 8_000, probe: () => Promise.resolve({ fingerprint: 'fp' }) }
      },
      scans.plan
    )
    await vi.waitFor(() => expect(scans.pending).toHaveLength(1))
    await scans.finish('/repos/freshness/v2', 10_000)
    expect((await verified).observation?.outcome).toMatchObject({
      worktrees: [{ path: '/repos/freshness/v2' }]
    })
  })

  it('never vouches for rows with a fingerprint that observed a mutation their scan missed', async () => {
    const target = repoFor('probe-order')
    let adminState = 'v1'
    let releaseProbe: () => void = () => {}
    const probeGate = new Promise<void>((resolve) => (releaseProbe = resolve))
    const pending: (() => void)[] = []
    const plan = {
      // Git observes admin state when it runs, not when the flight is created.
      scan: () => {
        const seen = adminState
        return new Promise<WorktreeCatalogOutcome>((resolve) =>
          pending.push(() =>
            resolve({
              kind: 'rows',
              worktrees: [
                {
                  path: seen,
                  head: 'a',
                  branch: 'refs/heads/main',
                  isBare: false,
                  isMainWorktree: true
                }
              ]
            })
          )
        )
      }
    }
    const requirement = {
      kind: 'runtime' as const,
      maxAgeMs: 5_000,
      verifier: {
        ceilingMs: 60_000,
        probe: () => probeGate.then(() => ({ fingerprint: adminState }))
      }
    }

    const first = readWorktreeCatalog(target, 'local:default', requirement, plan)
    // The repo mutates while the pre-scan probe is still reading.
    adminState = 'v2'
    releaseProbe()
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    vi.setSystemTime(1_000)
    pending.shift()!()
    await first

    // Past the window the probe matches the stored fingerprint, so the rows it vouches for must be v2.
    vi.setSystemTime(10_000)
    const reused = await readWorktreeCatalog(target, 'local:default', requirement, plan)
    expect(pending).toHaveLength(0)
    expect(reused.observation?.outcome).toMatchObject({ worktrees: [{ path: 'v2' }] })
  })
})
