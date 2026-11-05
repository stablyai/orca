import { describe, expect, it, vi } from 'vitest'

// The desktop's server-list feed loads react-native; its timer never runs without a subscriber.
vi.mock('react-native', () => ({}))
import type { MobileRelayHost } from '../../../src/shared/remote-runtime/relay/mobile-relay-hosts-contract'
import { fetchServerWorkspaces, ServerRowSnapshots } from './server-workspaces'

import type { Worktree } from './workspace-list-types'
import type { RpcClient } from '../transport/rpc-client'

const host: MobileRelayHost = {
  hostId: 'runtime:env-1',
  label: 'Box',
  health: 'available',
  relay: 'ready'
}

function row(worktreeId: string, hostId: MobileRelayHost['hostId'] = host.hostId): Worktree {
  return {
    worktreeId,
    repoId: 'repo-1',
    hostId,
    repo: 'orca',
    branch: 'main',
    displayName: worktreeId,
    path: `/srv/${worktreeId}`,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null
  }
}

// As the desktop sends a confirmed stop: no status, so 'disconnected', and the marker.

function serverClient(...worktreeReplies: unknown[]) {
  const sent: unknown[] = []
  const sendRequest = vi.fn(async (method: string, params?: unknown) => {
    if (method === 'mobileRelay.hosts.worktrees') {
      sent.push(params)
    }
    const result = method === 'mobileRelay.hosts.list' ? { hosts: [host] } : worktreeReplies.shift()
    return { id: 'reply', ok: true as const, result, _meta: { runtimeId: 'desktop' } }
  })
  const client: RpcClient = {
    sendRequest,
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  return { client, sent }
}

describe('server rows as snapshots', () => {
  it('rebuilds row deltas against the last rows and keeps rows a reply cannot rebuild', async () => {
    const renamed = { ...row('b'), displayName: 'b2' }
    const { client, sent } = serverClient(
      { worktrees: [row('a'), row('b')], snapshotId: 's1' },
      { snapshotId: 's2', baseSnapshotId: 's1', rowsFromBase: [renamed, 0] },
      { unchanged: true, snapshotId: 's2' },
      { worktrees: null }
    )
    const snapshots = new ServerRowSnapshots(true)
    const reads = []
    for (let read = 0; read < 4; read += 1) {
      reads.push((await fetchServerWorkspaces(client, snapshots))?.rows[0])
    }

    expect(reads).toEqual([[row('a'), row('b')], [renamed, row('a')], [renamed, row('a')], null])
    expect(sent).toEqual([
      { hostId: host.hostId, afterSnapshotId: null, acceptRowDelta: true },
      { hostId: host.hostId, afterSnapshotId: 's1', acceptRowDelta: true },
      { hostId: host.hostId, afterSnapshotId: 's2', acceptRowDelta: true },
      { hostId: host.hostId, afterSnapshotId: 's2', acceptRowDelta: true }
    ])
  })

  // A slow read on a replaced client must not take the snapshot back from the new one.
  it('keeps each client its own snapshot across a client switch and back', async () => {
    const a = serverClient(
      { worktrees: [row('a')], snapshotId: 's1' },
      { unchanged: true, snapshotId: 's1' }
    )
    const b = serverClient({ worktrees: [row('b')], snapshotId: 's2' })
    const snapshots = new ServerRowSnapshots(true)

    await fetchServerWorkspaces(a.client, snapshots)
    await fetchServerWorkspaces(b.client, snapshots)
    const back = await fetchServerWorkspaces(a.client, snapshots)

    expect(b.sent).toEqual([{ hostId: host.hostId, afterSnapshotId: null, acceptRowDelta: true }])
    expect(a.sent.at(-1)).toEqual({
      hostId: host.hostId,
      afterSnapshotId: 's1',
      acceptRowDelta: true
    })
    expect(back?.rows).toEqual([[row('a')]])
  })
})
