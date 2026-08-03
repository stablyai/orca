import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import {
  admitWorktreeCatalogResponse,
  WORKTREE_PS_FULL_LIMIT,
  WorktreeCatalogSnapshotClient
} from './worktree-catalog-snapshot-client'

describe('admitWorktreeCatalogResponse', () => {
  it('accepts new-host full and unchanged responses', () => {
    const full = admitWorktreeCatalogResponse(
      { worktrees: [{ id: 'worktree-1' }], snapshotId: 'snapshot-1' },
      null
    )
    const unchanged = admitWorktreeCatalogResponse(
      { unchanged: true, snapshotId: 'snapshot-1' },
      'snapshot-1'
    )

    expect(full).toEqual({
      kind: 'full',
      snapshotId: 'snapshot-1',
      worktrees: [{ id: 'worktree-1' }]
    })
    expect(unchanged).toEqual({ kind: 'unchanged', snapshotId: 'snapshot-1' })
  })

  it('treats an old-host full response as authoritative and clears the token', () => {
    expect(
      admitWorktreeCatalogResponse({ worktrees: [{ id: 'worktree-1' }] }, 'stale-token')
    ).toEqual({
      kind: 'full',
      snapshotId: null,
      worktrees: [{ id: 'worktree-1' }]
    })
  })

  it('classifies by rows, so a future `unchanged` catalog field cannot hide a full response', () => {
    expect(
      admitWorktreeCatalogResponse(
        { worktrees: [{ id: 'worktree-1' }], unchanged: false, snapshotId: 'snapshot-1' },
        'snapshot-1'
      )
    ).toEqual({
      kind: 'full',
      snapshotId: 'snapshot-1',
      worktrees: [{ id: 'worktree-1' }]
    })
  })

  it('rejects unchanged responses for a snapshot the client does not own', () => {
    expect(
      admitWorktreeCatalogResponse({ unchanged: true, snapshotId: 'snapshot-2' }, 'snapshot-1')
    ).toEqual({ kind: 'invalid' })
    expect(admitWorktreeCatalogResponse({ unchanged: true }, 'snapshot-1')).toEqual({
      kind: 'invalid'
    })
  })

  it('rejects malformed success payloads', () => {
    expect(admitWorktreeCatalogResponse(null, 'snapshot-1')).toEqual({ kind: 'invalid' })
    expect(admitWorktreeCatalogResponse({ unchanged: false }, 'snapshot-1')).toEqual({
      kind: 'invalid'
    })
  })

  it('accepts a full response but ignores an out-of-bounds snapshot id', () => {
    expect(
      admitWorktreeCatalogResponse({ worktrees: [], snapshotId: 'x'.repeat(129) }, null)
    ).toEqual({ kind: 'full', snapshotId: null, worktrees: [] })
  })
})

function clientWithResults(...results: unknown[]): RpcClient {
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
  it('returns the confirmed rows on unchanged responses so callers can reassert them', async () => {
    const rows = [{ worktreeId: 'worktree-1' }]
    const client = clientWithResults(
      { worktrees: rows, snapshotId: 'snapshot-1' },
      { unchanged: true, snapshotId: 'snapshot-1' }
    )
    const snapshots = new WorktreeCatalogSnapshotClient()

    const first = snapshots.admit(await snapshots.fetch(client, 'host-1'))
    const second = snapshots.admit(await snapshots.fetch(client, 'host-1'))

    expect(first).toEqual(rows)
    expect(second).toEqual(rows)
  })

  it('does not advance the token until the caller admits a response', async () => {
    const client = clientWithResults(
      { worktrees: [], snapshotId: 'snapshot-1' },
      { worktrees: [], snapshotId: 'snapshot-1' }
    )
    const snapshots = new WorktreeCatalogSnapshotClient()

    await snapshots.fetch(client, 'host-1')
    snapshots.admit(await snapshots.fetch(client, 'host-1'))

    expect(client.sendRequest).toHaveBeenNthCalledWith(2, 'worktree.ps', {
      limit: WORKTREE_PS_FULL_LIMIT,
      afterSnapshotId: null
    })
  })

  it('preserves the last admitted token across transport failures', async () => {
    const client = clientWithResults({ worktrees: [], snapshotId: 'snapshot-1' })
    const snapshots = new WorktreeCatalogSnapshotClient()

    snapshots.admit(await snapshots.fetch(client, 'host-1'))
    snapshots.admit(null)
    await snapshots.fetch(client, 'host-1')

    expect(client.sendRequest).toHaveBeenNthCalledWith(2, 'worktree.ps', {
      limit: WORKTREE_PS_FULL_LIMIT,
      afterSnapshotId: 'snapshot-1'
    })
  })

  it('clears snapshot ownership after a mismatched unchanged response', async () => {
    const client = clientWithResults(
      { worktrees: [], snapshotId: 'snapshot-1' },
      { unchanged: true, snapshotId: 'snapshot-2' },
      { worktrees: [], snapshotId: 'snapshot-3' }
    )
    const snapshots = new WorktreeCatalogSnapshotClient()

    snapshots.admit(await snapshots.fetch(client, 'host-1'))
    snapshots.admit(await snapshots.fetch(client, 'host-1'))
    await snapshots.fetch(client, 'host-1')

    expect(client.sendRequest).toHaveBeenNthCalledWith(3, 'worktree.ps', {
      limit: WORKTREE_PS_FULL_LIMIT,
      afterSnapshotId: null
    })
  })

  it('resets snapshot ownership when the client or host changes', async () => {
    const firstClient = clientWithResults({ worktrees: [], snapshotId: 'snapshot-1' })
    const secondClient = clientWithResults({ worktrees: [], snapshotId: 'snapshot-2' })
    const snapshots = new WorktreeCatalogSnapshotClient()

    snapshots.admit(await snapshots.fetch(firstClient, 'host-1'))
    await snapshots.fetch(secondClient, 'host-2')

    expect(secondClient.sendRequest).toHaveBeenCalledWith('worktree.ps', {
      limit: WORKTREE_PS_FULL_LIMIT,
      afterSnapshotId: null
    })
  })

  it('drops a superseded host response without invalidating the current token', async () => {
    const firstClient = clientWithResults({ worktrees: [], snapshotId: 'snapshot-1' })
    const secondClient = clientWithResults({ worktrees: [], snapshotId: 'snapshot-2' })
    const snapshots = new WorktreeCatalogSnapshotClient()

    // Host A's response is still in flight when the screen switches to host B.
    const stale = await snapshots.fetch(firstClient, 'host-1')
    snapshots.admit(await snapshots.fetch(secondClient, 'host-2'))
    expect(snapshots.admit(stale)).toBeNull()

    await snapshots.fetch(secondClient, 'host-2')
    expect(secondClient.sendRequest).toHaveBeenNthCalledWith(2, 'worktree.ps', {
      limit: WORKTREE_PS_FULL_LIMIT,
      afterSnapshotId: 'snapshot-2'
    })
  })
})
