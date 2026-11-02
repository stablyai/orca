import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreePsResult } from '../../../shared/runtime-types'
import { resolveWorktreeCatalogSnapshot } from './worktree-catalog-snapshot'

function result(totalCount: number): RuntimeWorktreePsResult {
  return { worktrees: [], totalCount, truncated: false }
}

describe('resolveWorktreeCatalogSnapshot', () => {
  it('returns unchanged only when the caller owns the exact current snapshot', () => {
    const first = resolveWorktreeCatalogSnapshot(result(1), { afterSnapshotId: null })
    expect(first).toMatchObject({ totalCount: 1 })

    const snapshotId = first.snapshotId
    expect(resolveWorktreeCatalogSnapshot(result(1), { afterSnapshotId: snapshotId })).toEqual({
      unchanged: true,
      snapshotId
    })
    expect(resolveWorktreeCatalogSnapshot(result(1), { afterSnapshotId: 'unknown' })).toEqual({
      ...result(1),
      snapshotId
    })
  })

  it('derives ids from content alone, so memo state cannot change the answer', () => {
    // Identical catalogs must yield identical ids whether the memo is warm or was just
    // displaced — that is what makes the memo droppable and restarts safe.
    const warm = resolveWorktreeCatalogSnapshot(result(1), { afterSnapshotId: null }).snapshotId
    resolveWorktreeCatalogSnapshot(result(99), { afterSnapshotId: null })

    expect(resolveWorktreeCatalogSnapshot(result(1), { afterSnapshotId: null }).snapshotId).toBe(
      warm
    )
  })
})
