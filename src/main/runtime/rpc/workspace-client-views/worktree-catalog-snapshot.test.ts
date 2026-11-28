import { describe, expect, it, vi } from 'vitest'
import type * as SnapshotIds from './content-snapshot-id'
import {
  resolveWorktreeCatalogSnapshot,
  WorktreeCatalogRowHashes
} from './worktree-catalog-snapshot'

const hashCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('./content-snapshot-id', async (importOriginal) => {
  const actual = await importOriginal<typeof SnapshotIds>()
  return {
    ...actual,
    contentSnapshotId: (serialized: string) => {
      hashCalls.count += 1
      return actual.contentSnapshotId(serialized)
    }
  }
})

function makeCatalog(count: number, extra: { truncated?: boolean } = {}) {
  return {
    ...extra,
    worktrees: Array.from({ length: count }, (_, index) => ({
      worktreeId: `repo-1::/srv/wt-${index}`,
      branch: `feature-${index}`,
      status: 'idle'
    }))
  }
}

describe('resolveWorktreeCatalogSnapshot', () => {
  it('avoids serializing and hashing on warm unchanged polls without an explicit memo', () => {
    const initial = resolveWorktreeCatalogSnapshot(makeCatalog(1_000), {
      afterSnapshotId: null,
      acceptRowDelta: true
    })
    expect('worktrees' in initial).toBe(true)

    const stringifySpy = vi.spyOn(JSON, 'stringify')
    hashCalls.count = 0
    try {
      for (let poll = 0; poll < 20; poll += 1) {
        const reply = resolveWorktreeCatalogSnapshot(makeCatalog(1_000), {
          afterSnapshotId: initial.snapshotId,
          acceptRowDelta: true
        })
        expect(reply).toEqual({ unchanged: true, snapshotId: initial.snapshotId })
      }
      expect(stringifySpy).not.toHaveBeenCalled()
      expect(hashCalls.count).toBe(0)
    } finally {
      stringifySpy.mockRestore()
    }
  })

  it('preserves identity and delta correctness across row edits, reorders, envelope changes, and in-place mutations', () => {
    const memo = new WorktreeCatalogRowHashes()
    const base = makeCatalog(4, { truncated: false })
    const first = resolveWorktreeCatalogSnapshot(
      base,
      { afterSnapshotId: null, acceptRowDelta: true },
      memo
    )

    // In-place mutation of a previously passed row must not return a false unchanged reply.
    base.worktrees[1]!.status = 'working'
    hashCalls.count = 0
    const afterMutation = resolveWorktreeCatalogSnapshot(
      base,
      { afterSnapshotId: first.snapshotId, acceptRowDelta: true },
      memo
    )
    expect('rowsFromBase' in afterMutation).toBe(true)
    if ('rowsFromBase' in afterMutation) {
      expect(afterMutation.baseSnapshotId).toBe(first.snapshotId)
      expect(afterMutation.rowsFromBase).toEqual([0, base.worktrees[1], 2, 3])
    }
    expect(hashCalls.count).toBe(2)

    // Row reorder produces an index-only delta without rehashing rows.
    const reordered = {
      truncated: false,
      worktrees: [base.worktrees[1]!, base.worktrees[0]!, base.worktrees[2]!, base.worktrees[3]!]
    }
    hashCalls.count = 0
    const afterReorder = resolveWorktreeCatalogSnapshot(
      reordered,
      { afterSnapshotId: afterMutation.snapshotId, acceptRowDelta: true },
      memo
    )
    expect('rowsFromBase' in afterReorder).toBe(true)
    if ('rowsFromBase' in afterReorder) {
      expect(afterReorder.rowsFromBase).toEqual([1, 0, 2, 3])
    }
    expect(hashCalls.count).toBe(1)

    // Envelope change changes snapshotId even when rows are identical.
    hashCalls.count = 0
    const afterEnvelopeChange = resolveWorktreeCatalogSnapshot(
      { ...reordered, truncated: true },
      { afterSnapshotId: afterReorder.snapshotId, acceptRowDelta: true },
      memo
    )
    expect('unchanged' in afterEnvelopeChange).toBe(false)
    expect(afterEnvelopeChange.snapshotId).not.toBe(afterReorder.snapshotId)
    expect('rowsFromBase' in afterEnvelopeChange).toBe(true)
    if ('rowsFromBase' in afterEnvelopeChange) {
      expect(afterEnvelopeChange.rowsFromBase).toEqual([0, 1, 2, 3])
    }
    expect(hashCalls.count).toBe(1)
  })

  it('avoids rehashing unchanged rows even when rows lack worktreeId', () => {
    const memo = new WorktreeCatalogRowHashes()
    const makeRows = () => ({
      worktrees: [
        { path: '/a', active: false },
        { path: '/b', active: true }
      ]
    })
    const first = resolveWorktreeCatalogSnapshot(makeRows(), { afterSnapshotId: null }, memo)

    hashCalls.count = 0
    const second = resolveWorktreeCatalogSnapshot(
      makeRows(),
      { afterSnapshotId: first.snapshotId },
      memo
    )
    expect(second).toEqual({ unchanged: true, snapshotId: first.snapshotId })
    expect(hashCalls.count).toBe(0)
  })
})
