import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'

import {
  WorktreeCatalogSnapshotClient,
  type WorktreeCatalogFetchResult
} from './worktree-catalog-snapshot-client'

function admitFetched(
  snapshots: WorktreeCatalogSnapshotClient,
  fetched: WorktreeCatalogFetchResult
) {
  return fetched.kind === 'response' ? snapshots.admit(fetched.pending) : null
}

function clientWithResults(...results: unknown[]): RpcClient {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this request-only seam intentionally supplies unchecked envelopes to snapshot admission.
  return {
    sendRequest: vi.fn(
      async () =>
        ({
          id: 'request',
          ok: true,
          result: results.shift(),
          _meta: { runtimeId: 'runtime' }
        }) as const
    )
  } as unknown as RpcClient
}

describe('WorktreeCatalogSnapshotClient', () => {
  it('rebuilds a row delta from the confirmed rows and asks for a full catalog when it cannot', async () => {
    const a = { worktreeId: 'a' }
    const b = { worktreeId: 'b' }
    const c = { worktreeId: 'c' }
    const client = clientWithResults(
      { worktrees: [a, b], snapshotId: 'snapshot-1' },
      { snapshotId: 'snapshot-2', baseSnapshotId: 'snapshot-1', rowsFromBase: [1, c, 0] },
      { snapshotId: 'snapshot-3', baseSnapshotId: 'snapshot-2', rowsFromBase: [7] },
      { worktrees: [], snapshotId: 'snapshot-4' }
    )
    const snapshots = new WorktreeCatalogSnapshotClient()

    // A caller sorting what it was given must not reorder the base the next delta indexes into.
    admitFetched(snapshots, await snapshots.fetch(client, 'host-1'))?.reverse()
    expect(admitFetched(snapshots, await snapshots.fetch(client, 'host-1'))).toEqual([b, c, a])
    expect(admitFetched(snapshots, await snapshots.fetch(client, 'host-1'))).toBeNull()
    await snapshots.fetch(client, 'host-1')

    expect(client.sendRequest).toHaveBeenNthCalledWith(4, 'worktree.ps', {
      limit: 10_000,
      afterSnapshotId: null,
      acceptRowDelta: true
    })
  })

  // A slow reply from before an A→B→A switch names a token whose rows were replaced.
  it('drops a late unchanged reply that answers a token this client no longer holds', async () => {
    const rows = [{ worktreeId: 'worktree-2' }]
    const clientA = clientWithResults(
      { worktrees: [{ worktreeId: 'worktree-1' }], snapshotId: 'snapshot-1' },
      { unchanged: true, snapshotId: 'snapshot-1' },
      { worktrees: rows, snapshotId: 'snapshot-2' },
      { unchanged: true, snapshotId: 'snapshot-2' }
    )
    const clientB = clientWithResults({ worktrees: [], snapshotId: 'snapshot-b' })
    const snapshots = new WorktreeCatalogSnapshotClient()

    admitFetched(snapshots, await snapshots.fetch(clientA, 'host-1'))
    const late = await snapshots.fetch(clientA, 'host-1')
    admitFetched(snapshots, await snapshots.fetch(clientB, 'host-1'))
    admitFetched(snapshots, await snapshots.fetch(clientA, 'host-1'))

    expect(admitFetched(snapshots, late)).toBeNull()
    expect(admitFetched(snapshots, await snapshots.fetch(clientA, 'host-1'))).toEqual(rows)
  })
})
