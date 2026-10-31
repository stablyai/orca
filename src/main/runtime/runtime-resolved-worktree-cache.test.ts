import { describe, expect, it } from 'vitest'
import { RuntimeResolvedWorktreeCache } from './runtime-resolved-worktree-cache'
import type { ResolvedWorktreeSnapshot } from './runtime-resolved-worktree-cache'
import {
  bumpLocalWorktreeScanGeneration,
  getLocalWorktreeScanGeneration,
  getWorktreeScanMutationRevision
} from '../local-worktree-scan-generation'

function snapshotOf(ids: string[]): ResolvedWorktreeSnapshot {
  return {
    worktrees: ids.map((id) => ({ id }) as ResolvedWorktreeSnapshot['worktrees'][number]),
    platformByRepoId: new Map()
  }
}

describe('RuntimeResolvedWorktreeCache', () => {
  it('reuses a snapshot inside the TTL while the repo inventory is unchanged', async () => {
    const cache = new RuntimeResolvedWorktreeCache()
    let computes = 0
    const compute = async (): Promise<ResolvedWorktreeSnapshot> => {
      computes += 1
      return snapshotOf(['repo-1::/a'])
    }

    await cache.getSnapshot(compute, 60_000, 7)
    const second = await cache.getSnapshot(compute, 60_000, 7)

    expect(computes).toBe(1)
    expect(second.worktrees.map((worktree) => worktree.id)).toEqual(['repo-1::/a'])
  })

  it('recomputes when the repo inventory moved, even well inside the TTL', async () => {
    // Repo registration invalidates earlier snapshots: absence there cannot prove workspace not found.
    const cache = new RuntimeResolvedWorktreeCache()
    const results = [snapshotOf(['repo-1::/a']), snapshotOf(['repo-1::/a', 'repo-2::/b'])]
    let computes = 0
    const compute = async (): Promise<ResolvedWorktreeSnapshot> => results[computes++]

    await cache.getSnapshot(compute, 60_000, 7)
    const afterRegistration = await cache.getSnapshot(compute, 60_000, 8)

    expect(computes).toBe(2)
    expect(afterRegistration.worktrees.map((worktree) => worktree.id)).toEqual([
      'repo-1::/a',
      'repo-2::/b'
    ])
  })

  it('does not join an in-flight compute that started under a stale inventory', async () => {
    const cache = new RuntimeResolvedWorktreeCache()
    const computed: number[] = []
    const compute = async (): Promise<ResolvedWorktreeSnapshot> => {
      computed.push(computed.length)
      return snapshotOf([])
    }

    const first = cache.getSnapshot(compute, 60_000, 7)
    const second = cache.getSnapshot(compute, 60_000, 8)
    await Promise.all([first, second])

    expect(computed).toHaveLength(2)
  })

  it('reports freshness against the inventory the snapshot was computed under', async () => {
    const cache = new RuntimeResolvedWorktreeCache()
    await cache.getSnapshot(async () => snapshotOf([]), 60_000, 7)

    expect(cache.isFresh(7)).toBe(true)
    expect(cache.isFresh(8)).toBe(false)
    cache.invalidateResolved()
    expect(cache.isFresh(7)).toBe(false)
  })

  it('keeps a primed snapshot servable when nothing mutated', async () => {
    // Headless reattach resolves from a primed cache without Git; non-mutation reads must preserve its freshness.
    const cache = new RuntimeResolvedWorktreeCache()
    let computes = 0
    const prime = async (): Promise<ResolvedWorktreeSnapshot> => {
      computes += 1
      return snapshotOf(['repo-restore::/tmp/restore-records'])
    }
    await cache.getSnapshot(prime, 60_000, getWorktreeScanMutationRevision())

    // A read that mints a scan generation for a repo nothing has scanned yet is not a mutation.
    getLocalWorktreeScanGeneration(`repo-never-scanned-${Math.random()}`)

    expect(cache.isFresh(getWorktreeScanMutationRevision())).toBe(true)
    const served = await cache.getSnapshot(prime, 60_000, getWorktreeScanMutationRevision())
    expect(computes).toBe(1)
    expect(served.worktrees.map((worktree) => worktree.id)).toEqual([
      'repo-restore::/tmp/restore-records'
    ])
  })
})

describe('getWorktreeScanMutationRevision', () => {
  it('advances on a repo mutation and not on a first-seen generation read', () => {
    const repoId = `repo-${Math.random()}`
    const before = getWorktreeScanMutationRevision()

    getLocalWorktreeScanGeneration(repoId)
    expect(getWorktreeScanMutationRevision()).toBe(before)

    bumpLocalWorktreeScanGeneration(repoId)
    expect(getWorktreeScanMutationRevision()).toBe(before + 1)
  })
})
