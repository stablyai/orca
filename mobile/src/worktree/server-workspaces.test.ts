import { describe, expect, it, vi } from 'vitest'

// The desktop's server-list feed loads react-native; its timer never runs without a subscriber.
vi.mock('react-native', () => ({}))
import type { MobileRelayHost } from '../../../src/shared/mobile-relay-hosts-contract'
import {
  applyServerWorkspaces,
  fetchServerWorkspaces,
  NO_SERVER_WORKSPACES,
  ServerRowSnapshots,
  serverHostHealthLabel,
  serverHostHealthLabels,
  type ServerWorkspaces
} from './server-workspaces'
import { relayHostsListRead } from './server-workspace-operations'
import { applyWorktreeHostContextLabels } from './worktree-host-context-labels'
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

describe('applyServerWorkspaces', () => {
  it('keeps the same hosts list when only the rows change', () => {
    const first = applyServerWorkspaces(NO_SERVER_WORKSPACES, {
      hosts: [host],
      rows: [[row('a')]]
    })
    const next = applyServerWorkspaces(first, {
      hosts: [{ ...host }],
      rows: [[row('a'), row('b')]]
    })
    expect(next.worktrees.map((worktree) => worktree.worktreeId)).toEqual(['a', 'b'])
    expect(next.hosts).toBe(first.hosts)
    const relabeled = applyServerWorkspaces(next, {
      hosts: [{ ...host, relay: 'unavailable' }],
      rows: [null]
    })
    expect(relabeled.hosts).not.toBe(first.hosts)
    expect(relabeled.worktrees).toEqual(next.worktrees)
    expect(
      applyServerWorkspaces(next, {
        hosts: [{ ...host }],
        rows: [[row('a'), row('b')]]
      })
    ).toBe(next)
  })

  it('keeps cached rows for failed servers with one ownership read per row', () => {
    const hosts = Array.from({ length: 20 }, (_, index): MobileRelayHost => ({
      ...host,
      hostId: `runtime:env-${index}`
    }))
    let ownershipReads = 0
    const previous: ServerWorkspaces = {
      hosts,
      worktrees: hosts.flatMap((server) =>
        ['a', 'b'].map((slot) => ({
          ...row(`${server.hostId}-${slot}`, server.hostId),
          get hostId() {
            ownershipReads += 1
            return server.hostId
          }
        }))
      )
    }
    const recovered = row('recovered', hosts[0]!.hostId)
    const nextHosts = hosts.slice(0, -1).map((server) => ({ ...server }))
    const next = applyServerWorkspaces(previous, {
      hosts: nextHosts,
      rows: nextHosts.map((_, index) => (index === 0 ? [recovered] : null))
    })
    const expected = [recovered, ...previous.worktrees.slice(2, -2)]
    expect(next.worktrees).toHaveLength(expected.length)
    expected.forEach((entry, index) => expect(next.worktrees[index]).toBe(entry))
    expect(ownershipReads).toBeLessThanOrEqual(previous.worktrees.length)
  })
})

function listReply(hosts: unknown[]) {
  return relayHostsListRead.interpret({
    id: 'reply',
    ok: true,
    result: { hosts },
    _meta: { runtimeId: 'desktop' }
  })
}

// As the desktop sends a confirmed stop: no status, so 'disconnected', and the marker.
const wslHost: MobileRelayHost = {
  hostId: 'runtime:wsl%3Aubuntu',
  label: 'Ubuntu (WSL)',
  health: 'disconnected',
  relay: 'unavailable',
  stoppedOnDesktop: true
}

describe("the desktop's own WSL host", () => {
  it('reads the marker from a new desktop, and lists an older desktop’s hosts without it', () => {
    const listed = listReply([
      wslHost,
      { ...host, stoppedOnDesktop: 'yes', unavailableOnDesktop: 1 },
      {
        hostId: 'runtime:old',
        label: 'Old',
        health: 'available',
        relay: 'ready'
      }
    ])
    expect(listed.accepted && listed.value).toEqual([
      wslHost,
      { ...host, stoppedOnDesktop: undefined, unavailableOnDesktop: undefined },
      {
        hostId: 'runtime:old',
        label: 'Old',
        health: 'available',
        relay: 'ready'
      }
    ])
  })

  it('says to start it on the computer only for a stop the desktop confirmed', () => {
    expect(serverHostHealthLabel(wslHost)).toBe('Start on computer')
    // Starting, reconnecting or unconfirmed reads exactly like this on the wire: no marker.
    const { stoppedOnDesktop: _marker, ...unconfirmed } = wslHost
    expect(serverHostHealthLabel(unconfirmed)).toBeUndefined()
    expect(serverHostHealthLabels([unconfirmed]).size).toBe(0)
    // Not connected on the computer and not known stopped: say where to open it, not "Connecting".
    expect(
      serverHostHealthLabel({
        ...unconfirmed,
        health: 'connecting',
        unavailableOnDesktop: true
      })
    ).toBe('Open on computer')
    // Any other server keeps its health word.
    expect(serverHostHealthLabel({ ...host, relay: 'unavailable' })).toBeUndefined()
  })

  it("puts the words on that host's rows, over its health", () => {
    const [drawn] = applyWorktreeHostContextLabels([{ ...row('a'), hostId: wslHost.hostId }], {
      repoHostIdByRepoId: new Map(),
      hostLabelById: new Map([[wslHost.hostId, wslHost.label]]),
      hostPlatform: 'win32',
      hostHealthById: new Map([[wslHost.hostId, wslHost.health]]),
      hostHealthLabelById: serverHostHealthLabels([wslHost, host])
    })
    expect(drawn).toMatchObject({
      hostContextLabel: 'Ubuntu (WSL)',
      hostContextHealthLabel: 'Start on computer'
    })
  })

  it('keeps an older desktop’s list as it was: no marker, no WSL host, the health word only', () => {
    const listed = listReply([{ ...host, health: 'disconnected', relay: 'unavailable' }])
    const hosts = listed.accepted ? listed.value : []
    expect(serverHostHealthLabels(hosts).size).toBe(0)
    const [drawn] = applyWorktreeHostContextLabels([row('a')], {
      repoHostIdByRepoId: new Map(),
      hostLabelById: new Map([[host.hostId, host.label]]),
      hostPlatform: 'win32',
      hostHealthById: new Map([[host.hostId, 'disconnected' as const]]),
      hostHealthLabelById: serverHostHealthLabels(hosts)
    })
    expect(drawn.hostContextHealthLabel).toBe('Disconnected')
  })
})

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
  it('reads an older desktop with only the host id, as before', async () => {
    const { client, sent } = serverClient({ worktrees: [row('a')] })

    const fetched = await fetchServerWorkspaces(client, new ServerRowSnapshots(false))

    expect(sent).toEqual([{ hostId: host.hostId }])
    expect(fetched?.rows).toEqual([[row('a')]])
  })

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
