import { expect, it, vi } from 'vitest'
import type { MobileRelayHost } from '../../../../src/shared/remote-runtime/relay/mobile-relay-hosts-contract'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { ServerRowSnapshots } from './server-workspaces'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, AppState: {} }))

const host = (hostId: `runtime:${string}`): MobileRelayHost => ({
  hostId,
  label: hostId,
  health: 'available',
  relay: 'ready'
})

it('drops a retired server’s snapshot, so the server re-added later starts a fresh read', async () => {
  const requestedAfter: { hostId: string; afterSnapshotId: unknown }[] = []
  const sendRequest = vi.fn(async (_method: string, params?: Record<string, unknown>) => {
    const hostId = String(params?.hostId)
    const afterSnapshotId = params?.afterSnapshotId
    requestedAfter.push({ hostId, afterSnapshotId })
    const snapshotId = `snap-${hostId}`
    if (afterSnapshotId === snapshotId) {
      return { ok: true, result: { unchanged: true, snapshotId } }
    }
    return {
      ok: true,
      result: {
        snapshotId,
        worktrees: [{ hostId, worktreeId: `${hostId}-wt`, repoId: 'repo-1' }]
      }
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the snapshot reads only invoke sendRequest on the client.
  const client = { sendRequest } as unknown as RpcClient
  const snapshots = new ServerRowSnapshots(true)

  await snapshots.read(client, [host('runtime:a'), host('runtime:b')])
  // The desktop stops listing runtime:a; runtime:b keeps its snapshot.
  await snapshots.read(client, [host('runtime:b')])
  requestedAfter.length = 0
  await snapshots.read(client, [host('runtime:a'), host('runtime:b')])

  // Servers are read concurrently, so compare in host order.
  requestedAfter.sort((left, right) => left.hostId.localeCompare(right.hostId))
  expect(requestedAfter).toEqual([
    { hostId: 'runtime:a', afterSnapshotId: null },
    { hostId: 'runtime:b', afterSnapshotId: 'snap-runtime:b' }
  ])
})
