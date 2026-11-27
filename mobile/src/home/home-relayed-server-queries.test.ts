import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY,
  MOBILE_RELAY_HOST_ROWS_CHANGED_EVENT_RUNTIME_CAPABILITY,
  MOBILE_RELAY_HOST_WORKTREE_DELTAS_RUNTIME_CAPABILITY
} from '../../../src/shared/remote-runtime/relay/mobile-desktop-relay-contract'
import type { MobileRelayHost } from '../../../src/shared/remote-runtime/relay/mobile-relay-hosts-contract'
import type { HostSignalEvent } from '../query/host-query'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'

const status = vi.hoisted((): { capabilities: string[] } => ({ capabilities: [] }))
const readHosts = vi.hoisted(() => vi.fn<() => Promise<MobileRelayHost[] | null>>(async () => []))

vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, AppState: {} }))
vi.mock('../query/host-status-query', () => ({
  readHostStatusReply: async () => ({}),
  decodeHostStatusReply: () => ({ status: { capabilities: status.capabilities } })
}))
vi.mock('../worktree/execution-hosts/relay-hosts-feed', () => ({
  relayHostsFeed: () => ({ read: readHosts })
}))

const { homeRelayedServerRowsQuery, homeRelayedServersQuery } =
  await import('./home-relayed-server-queries')

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fetch hands the client only to the mocked status and host reads.
const client = {} as RpcClient
const read = { live: false, previousFromStore: false, hostId: 'desk-a' }

describe('Home relayed server reads', () => {
  beforeEach(() => {
    readHosts.mockClear()
  })

  it('re-reads a server only for its own row notice, never on a timer', () => {
    const signal = homeRelayedServerRowsQuery.signal
    const notice: HostSignalEvent = { type: 'relayHostRowsChanged', hostId: 'runtime:a' }
    expect(homeRelayedServerRowsQuery).not.toHaveProperty('refetchInterval')
    expect(homeRelayedServersQuery).not.toHaveProperty('refetchInterval')
    expect(signal?.events).toContain('relayHostRowsChanged')
    expect(signal?.matches?.(notice, { exec: 'runtime:a' })).toBe(true)
    expect(signal?.matches?.(notice, { exec: 'runtime:b' })).toBe(false)
    // A host list change re-reads no server whose read is already mounted.
    expect(signal?.events).not.toContain('relayHostsChanged')
  })

  it('reads no relayed servers from a desktop that does not announce their changes', async () => {
    status.capabilities = [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY]
    await homeRelayedServersQuery.fetch(client, { exec: 'local' }, {}, undefined, read)
    expect(readHosts).not.toHaveBeenCalled()

    status.capabilities = [
      MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY,
      MOBILE_RELAY_HOST_ROWS_CHANGED_EVENT_RUNTIME_CAPABILITY
    ]
    await homeRelayedServersQuery.fetch(client, { exec: 'local' }, {}, undefined, read)
    expect(readHosts).toHaveBeenCalledTimes(1)
  })

  it('evicts retired servers from private snapshots when the desktop host list drops them', async () => {
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: readOne only invokes sendRequest on the client.
    const snapshotClient = { sendRequest } as unknown as RpcClient
    const host = (hostId: `runtime:${string}`): MobileRelayHost => ({
      hostId,
      label: hostId,
      health: 'available',
      relay: 'ready'
    })
    status.capabilities = [
      MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY,
      MOBILE_RELAY_HOST_ROWS_CHANGED_EVENT_RUNTIME_CAPABILITY,
      MOBILE_RELAY_HOST_WORKTREE_DELTAS_RUNTIME_CAPABILITY
    ]

    await homeRelayedServerRowsQuery.fetch(
      snapshotClient,
      { exec: 'runtime:a' },
      { deltas: true, rowChanges: true },
      undefined,
      read
    )
    await homeRelayedServerRowsQuery.fetch(
      snapshotClient,
      { exec: 'runtime:b' },
      { deltas: true, rowChanges: true },
      undefined,
      read
    )
    // Retire runtime:a; keep runtime:b.
    readHosts.mockResolvedValueOnce([host('runtime:b')])
    await homeRelayedServersQuery.fetch(snapshotClient, { exec: 'local' }, {}, undefined, read)
    // A failed host-list read must not evict runtime:b's snapshot.
    readHosts.mockResolvedValueOnce(null)
    await homeRelayedServersQuery.fetch(snapshotClient, { exec: 'local' }, {}, undefined, read)

    requestedAfter.length = 0
    await homeRelayedServerRowsQuery.fetch(
      snapshotClient,
      { exec: 'runtime:a' },
      { deltas: true, rowChanges: true },
      undefined,
      read
    )
    await homeRelayedServerRowsQuery.fetch(
      snapshotClient,
      { exec: 'runtime:b' },
      { deltas: true, rowChanges: true },
      undefined,
      read
    )
    expect(requestedAfter).toEqual([
      { hostId: 'runtime:a', afterSnapshotId: null },
      { hostId: 'runtime:b', afterSnapshotId: 'snap-runtime:b' }
    ])
  })
})
