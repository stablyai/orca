import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreePsResult } from '../../../shared/runtime-types'
import { resolveWorktreeCatalogSnapshot } from './worktree-catalog-snapshot'

function result(totalCount: number): RuntimeWorktreePsResult {
  return { worktrees: [], totalCount, truncated: false }
}

describe('resolveWorktreeCatalogSnapshot', () => {
  it('returns unchanged only when the caller owns the exact current snapshot', () => {
    const first = resolveWorktreeCatalogSnapshot(result(1), null)
    expect(first).toMatchObject({ totalCount: 1 })

    const snapshotId = first.snapshotId
    expect(resolveWorktreeCatalogSnapshot(result(1), snapshotId)).toEqual({
      unchanged: true,
      snapshotId
    })
    expect(resolveWorktreeCatalogSnapshot(result(1), 'unknown')).toEqual({
      ...result(1),
      snapshotId
    })
  })

  it('issues a new snapshot id for changed content', () => {
    const first = resolveWorktreeCatalogSnapshot(result(1), null)
    const changed = resolveWorktreeCatalogSnapshot(result(2), first.snapshotId)

    expect(changed.snapshotId).not.toBe(first.snapshotId)
    expect(changed).not.toHaveProperty('unchanged')
  })

  it('keeps concurrent callers independent without server-held state', () => {
    // Two clients on different catalogs interleave; neither can displace the other.
    const wide = resolveWorktreeCatalogSnapshot(result(2), null)
    const narrow = resolveWorktreeCatalogSnapshot(result(1), null)

    expect(resolveWorktreeCatalogSnapshot(result(2), wide.snapshotId)).toEqual({
      unchanged: true,
      snapshotId: wide.snapshotId
    })
    expect(resolveWorktreeCatalogSnapshot(result(1), narrow.snapshotId)).toEqual({
      unchanged: true,
      snapshotId: narrow.snapshotId
    })
  })

  it('repairs a caller holding a superseded snapshot with a full response', () => {
    const older = resolveWorktreeCatalogSnapshot(result(1), null)

    const repaired = resolveWorktreeCatalogSnapshot(result(2), older.snapshotId)
    expect(repaired).toMatchObject({ totalCount: 2 })
    expect(repaired).not.toHaveProperty('unchanged')
    expect(repaired.snapshotId).not.toBe(older.snapshotId)
  })

  it('derives ids from content alone, so memo state cannot change the answer', () => {
    // Identical catalogs must yield identical ids whether the memo is warm or was just
    // displaced — that is what makes the memo droppable and restarts safe.
    const warm = resolveWorktreeCatalogSnapshot(result(1), null).snapshotId
    resolveWorktreeCatalogSnapshot(result(99), null)

    expect(resolveWorktreeCatalogSnapshot(result(1), null).snapshotId).toBe(warm)
  })

  it('isolates the memo from mutation of a previously resolved catalog', () => {
    const mutable = result(1)
    const first = resolveWorktreeCatalogSnapshot(mutable, null)

    mutable.totalCount = 2
    const changed = resolveWorktreeCatalogSnapshot(mutable, first.snapshotId)

    expect(changed).toMatchObject({ totalCount: 2 })
    expect(changed).not.toHaveProperty('unchanged')
    expect(changed.snapshotId).not.toBe(first.snapshotId)
  })

  it('produces ids within the request schema bound', () => {
    const { snapshotId } = resolveWorktreeCatalogSnapshot(result(1), null)
    expect(snapshotId.length).toBeGreaterThan(0)
    expect(snapshotId.length).toBeLessThanOrEqual(128)
  })
})
