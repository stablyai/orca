import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RUNTIME_PROTOCOL_VERSION } from '../../../shared/protocol-version'
import {
  runtimeEnvironmentStatusFromSnapshot,
  type RuntimeHostStatusSnapshot
} from '../../../shared/runtime-host-status'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { SshConnectionState } from '../../../shared/ssh-types'
import type { MobileDesktopRelayHosts } from '../mobile-desktop-relay/mobile-desktop-relay-hosts'
import { FALLBACK_REFRESH_MS, PairedServerRowsProducer } from './paired-server-rows-producer'

function snapshot(environmentId: string, live: boolean): RuntimeHostStatusSnapshot {
  return {
    environmentId,
    pairingRevision: 1,
    sequence: 1,
    checkedAt: 1,
    status: {
      runtimeId: 'runtime-a',
      rendererGraphEpoch: 0,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0,
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION
    },
    verification: live ? 'verified' : 'unavailable',
    transport: live ? 'ready' : 'disconnected'
  }
}

function psReply(rows: Record<string, unknown>[]): RuntimeRpcResponse<unknown> {
  return { id: 'ps', ok: true, result: { worktrees: rows }, _meta: { runtimeId: 'runtime-a' } }
}

function row(worktreeId: string, extra: Record<string, unknown> = {}) {
  return {
    worktreeId,
    repoId: 'repo',
    path: `/srv/${worktreeId}`,
    branch: 'main',
    displayName: worktreeId,
    isArchived: false,
    isPinned: false,
    ...extra
  }
}

function fakeHosts(servers: { id: string; live: boolean }[]) {
  const state = { servers, pairingRevision: 1 }
  const statusListeners = new Set<() => void>()
  const retiredListeners = new Set<(environmentId: string) => void>()
  const watches = new Map<
    string,
    { onChange: () => void; onClose: () => void; closed: boolean; ended: boolean }
  >()
  const call = vi.fn<MobileDesktopRelayHosts['call']>()
  const hosts: MobileDesktopRelayHosts = {
    list: () => ({
      environments: state.servers.map(({ id }) => ({
        id,
        name: id,
        pairingRevision: state.pairingRevision,
        runtimeId: 'runtime-a'
      })),
      statusByEnvironmentId: new Map(
        state.servers.map(({ id, live }) => [
          id,
          runtimeEnvironmentStatusFromSnapshot(snapshot(id, live))
        ])
      ),
      sshTargetLabels: new Map<string, string>(),
      sshConnectionStates: new Map<string, SshConnectionState>()
    }),
    resolve: async () => null,
    call,
    hostsBrowserPage: () => false,
    onEnvironmentRetired: (listener) => {
      retiredListeners.add(listener)
      return () => retiredListeners.delete(listener)
    },
    onStatusChanged: (listener) => {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },
    watchChanges: (host, _expected, callbacks) => {
      const watch = { ...callbacks, closed: false, ended: false }
      watches.set(host.environmentId, watch)
      return {
        close: () => {
          watch.closed = true
        },
        current: () => !watch.closed && !watch.ended
      }
    }
  }
  return {
    hosts,
    call,
    state,
    watches,
    publishStatus: () => statusListeners.forEach((listener) => listener()),
    retire: (environmentId: string) =>
      retiredListeners.forEach((listener) => listener(environmentId))
  }
}

function rowsOf(producer: PairedServerRowsProducer, hostId: string) {
  return producer.snapshot().servers.find((server) => server.hostId === hostId)
}

describe('PairedServerRowsProducer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('populates from a server in contact once its change stream is ready', async () => {
    const { hosts, call, watches } = fakeHosts([{ id: 'box', live: true }])
    call.mockResolvedValue(
      psReply([row('repo::/a', { workspaceKind: 'git', liveTerminalCount: 1, status: 'active' })])
    )
    const producer = new PairedServerRowsProducer({
      hasDemand: () => true,
      hostLabelOverrides: () => new Map()
    })
    producer.attach(hosts)
    expect(rowsOf(producer, 'runtime:box')).toEqual({
      hostId: 'runtime:box',
      freshness: 'unverifiable',
      host: { label: 'box', health: 'available', compatibility: 'ok', pairedDeviceId: null },
      rows: []
    })

    watches.get('box')?.onChange()
    await vi.advanceTimersByTimeAsync(0)

    expect(call).toHaveBeenCalledWith(
      { environmentId: 'box' },
      'worktree.ps',
      { limit: 10_000, supportsWorktreeVisibilitySourceDefaults: true },
      { timeoutMs: 5_000, expected: { pairingRevision: 1, runtimeId: 'runtime-a' } }
    )
    expect(rowsOf(producer, 'runtime:box')).toEqual({
      hostId: 'runtime:box',
      freshness: 'live',
      host: { label: 'box', health: 'available', compatibility: 'ok', pairedDeviceId: null },
      rows: [
        {
          key: 'runtime:box|repo::/a',
          kind: 'git',
          worktreeId: 'repo::/a',
          repoId: 'repo',
          path: '/srv/repo::/a',
          branch: 'main',
          displayName: 'repo::/a',
          isArchived: false,
          isPinned: false,
          isMainWorktree: false,
          lineage: null,
          workspaceStatus: 'in-progress',
          // The server's own terminals and agents.
          activity: { terminal: 'live', agent: null }
        }
      ]
    })
  })

  it('refetches on a change event and drops workspaces the server deleted', async () => {
    const { hosts, call, watches } = fakeHosts([{ id: 'box', live: true }])
    call.mockResolvedValueOnce(psReply([row('a'), row('b')]))
    const producer = new PairedServerRowsProducer({
      hasDemand: () => true,
      hostLabelOverrides: () => new Map()
    })
    producer.attach(hosts)
    watches.get('box')?.onChange()
    await vi.advanceTimersByTimeAsync(0)
    const before = producer.snapshot().revision

    call.mockResolvedValueOnce(psReply([row('b')]))
    watches.get('box')?.onChange()
    await vi.advanceTimersByTimeAsync(0)

    expect(rowsOf(producer, 'runtime:box')?.rows.map((entry) => entry.worktreeId)).toEqual(['b'])
    expect(producer.snapshot().revision).toBeGreaterThan(before)
  })

  it('runs one more fetch for a change that lands while a fetch is in flight', async () => {
    const { hosts, call, watches } = fakeHosts([{ id: 'box', live: true }])
    let answer: (response: RuntimeRpcResponse<unknown>) => void = () => {}
    call.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    call.mockResolvedValueOnce(psReply([row('new')]))
    const producer = new PairedServerRowsProducer({
      hasDemand: () => true,
      hostLabelOverrides: () => new Map()
    })
    producer.attach(hosts)
    watches.get('box')?.onChange()
    watches.get('box')?.onChange()
    watches.get('box')?.onChange()
    answer(psReply([row('old')]))
    await vi.advanceTimersByTimeAsync(0)

    expect(call).toHaveBeenCalledTimes(2)
    expect(rowsOf(producer, 'runtime:box')?.rows.map((entry) => entry.worktreeId)).toEqual(['new'])
  })

  it('keeps the last rows as unverifiable when the server loses contact or stops answering', async () => {
    const { hosts, call, watches, state, publishStatus } = fakeHosts([{ id: 'box', live: true }])
    call.mockResolvedValueOnce(psReply([row('a')]))
    const producer = new PairedServerRowsProducer({
      hasDemand: () => true,
      hostLabelOverrides: () => new Map()
    })
    producer.attach(hosts)
    watches.get('box')?.onChange()
    await vi.advanceTimersByTimeAsync(0)

    call.mockRejectedValueOnce(new Error('timeout'))
    await producer.refresh('box')
    expect(rowsOf(producer, 'runtime:box')).toMatchObject({
      freshness: 'unverifiable',
      rows: [{ worktreeId: 'a' }]
    })

    call.mockResolvedValueOnce(psReply([row('a')]))
    await producer.refresh('box')
    expect(rowsOf(producer, 'runtime:box')?.freshness).toBe('live')

    state.servers = [{ id: 'box', live: false }]
    publishStatus()
    expect(watches.get('box')?.closed).toBe(true)
    expect(rowsOf(producer, 'runtime:box')).toMatchObject({
      freshness: 'unverifiable',
      rows: [{ worktreeId: 'a' }]
    })
  })

  it('watches again and refetches when the server comes back into contact', async () => {
    const { hosts, call, watches, state, publishStatus } = fakeHosts([{ id: 'box', live: false }])
    call.mockResolvedValue(psReply([row('a')]))
    const producer = new PairedServerRowsProducer({
      hasDemand: () => true,
      hostLabelOverrides: () => new Map()
    })
    producer.attach(hosts)
    expect(watches.has('box')).toBe(false)

    state.servers = [{ id: 'box', live: true }]
    publishStatus()
    watches.get('box')?.onChange()
    await vi.advanceTimersByTimeAsync(0)

    expect(rowsOf(producer, 'runtime:box')?.freshness).toBe('live')
  })

  it("drops a removed or re-paired server's rows, even ones a fetch delivers afterwards", async () => {
    const { hosts, call, watches, state, retire } = fakeHosts([{ id: 'box', live: true }])
    let answer: (response: RuntimeRpcResponse<unknown>) => void = () => {}
    call.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    const producer = new PairedServerRowsProducer({
      hasDemand: () => true,
      hostLabelOverrides: () => new Map()
    })
    producer.attach(hosts)
    watches.get('box')?.onChange()

    state.pairingRevision = 2
    retire('box')
    answer(psReply([row('old-pairing')]))
    await vi.advanceTimersByTimeAsync(0)
    expect(rowsOf(producer, 'runtime:box')).toEqual({
      hostId: 'runtime:box',
      freshness: 'unverifiable',
      host: { label: 'box', health: 'available', compatibility: 'ok', pairedDeviceId: null },
      rows: []
    })

    state.servers = []
    retire('box')
    expect(producer.snapshot().servers).toEqual([])
  })

  it('refreshes every server in contact every 30 s, only while the list is showing', async () => {
    const { hosts, call } = fakeHosts([
      { id: 'box', live: true },
      { id: 'down', live: false }
    ])
    call.mockResolvedValue(psReply([]))
    let showing = false
    const producer = new PairedServerRowsProducer({
      hasDemand: () => showing,
      hostLabelOverrides: () => new Map()
    })
    const detach = producer.attach(hosts)

    await vi.advanceTimersByTimeAsync(FALLBACK_REFRESH_MS)
    expect(call).not.toHaveBeenCalled()

    showing = true
    await vi.advanceTimersByTimeAsync(FALLBACK_REFRESH_MS)
    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0]?.[0]).toEqual({ environmentId: 'box' })

    detach()
    await vi.advanceTimersByTimeAsync(FALLBACK_REFRESH_MS)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('carries what the list sorts, groups and filters by, dropping a value this build cannot read', async () => {
    const { hosts, call, watches } = fakeHosts([{ id: 'box', live: true }])
    call.mockResolvedValueOnce(
      psReply([
        row('repo::/a', {
          isMainWorktree: true,
          workspaceStatus: 'in-review',
          sortOrder: 4,
          manualOrder: 2,
          lastActivityAt: 900,
          smartTier: 'done',
          smartAt: 800,
          createdAt: 100,
          creatorProvenance: { kind: 'paired-device', deviceId: 'phone-1' },
          defaultBranch: true,
          cliCreated: true,
          unread: true,
          worktreeInstanceId: 'i-a',
          parentWorktreeId: 'repo::/p',
          lineageWorktreeInstanceId: 'i-a',
          parentWorktreeInstanceId: 'i-p'
        }),
        row('repo::/b', { smartTier: 'a-tier-from-later', sortOrder: 'x' })
      ])
    )
    const producer = new PairedServerRowsProducer({
      hasDemand: () => true,
      hostLabelOverrides: () => new Map()
    })
    producer.attach(hosts)
    watches.get('box')?.onChange()
    await vi.advanceTimersByTimeAsync(0)

    const [newer, unreadable] = rowsOf(producer, 'runtime:box')?.rows ?? []
    expect(newer).toMatchObject({
      isMainWorktree: true,
      workspaceStatus: 'in-review',
      sortOrder: 4,
      manualOrder: 2,
      recentAt: 900,
      smartTier: 'done',
      smartAt: 800,
      createdAt: 100,
      creatorProvenance: { kind: 'paired-device', deviceId: 'phone-1' },
      defaultBranch: true,
      cliCreated: true,
      isUnread: true,
      instanceId: 'i-a',
      lineage: {
        parentWorktreeId: 'repo::/p',
        worktreeInstanceId: 'i-a',
        parentWorktreeInstanceId: 'i-p'
      }
    })
    expect(unreadable).toMatchObject({
      key: 'runtime:box|repo::/b',
      isMainWorktree: false,
      lineage: null,
      workspaceStatus: 'in-progress'
    })
    expect(unreadable?.smartTier).toBeUndefined()
    expect(unreadable?.sortOrder).toBeUndefined()
  })

  it("keys rows by host, so two servers' same bare id never collide, and fills older servers' gaps", async () => {
    const { hosts, call, watches } = fakeHosts([
      { id: 'one', live: true },
      { id: 'two', live: true }
    ])
    // An older server sends no workspaceKind or displayName; a newer one an arm this build lacks.
    call.mockResolvedValueOnce(
      psReply([{ worktreeId: 'same', repoId: 'r', path: '/p', branch: 'b' }])
    )
    call.mockResolvedValueOnce(
      psReply([row('same', { workspaceKind: 'future-kind' }), { path: '/no-id' }])
    )
    const producer = new PairedServerRowsProducer({
      hasDemand: () => true,
      hostLabelOverrides: () => new Map()
    })
    producer.attach(hosts)
    watches.get('one')?.onChange()
    await vi.advanceTimersByTimeAsync(0)
    watches.get('two')?.onChange()
    await vi.advanceTimersByTimeAsync(0)

    expect(rowsOf(producer, 'runtime:one')?.rows).toEqual([
      {
        key: 'runtime:one|same',
        kind: 'git',
        worktreeId: 'same',
        repoId: 'r',
        path: '/p',
        branch: 'b',
        displayName: '',
        isArchived: false,
        isPinned: false,
        isMainWorktree: false,
        lineage: null,
        workspaceStatus: 'in-progress',
        activity: { terminal: null, agent: null }
      }
    ])
    expect(rowsOf(producer, 'runtime:two')?.rows.map((entry) => [entry.key, entry.kind])).toEqual([
      ['runtime:two|same', 'git']
    ])
  })

  it('serves raw rows only under the pairing they were fetched for', async () => {
    const { hosts, call, watches } = fakeHosts([{ id: 'box', live: true }])
    call.mockResolvedValueOnce(psReply([row('a', { preview: 'kept as sent' })]))
    const producer = new PairedServerRowsProducer({
      hasDemand: () => true,
      hostLabelOverrides: () => new Map()
    })
    producer.attach(hosts)
    watches.get('box')?.onChange()
    await vi.advanceTimersByTimeAsync(0)

    expect(producer.rows('box', '1\0runtime-a')).toEqual([
      { ...row('a', { preview: 'kept as sent' }), hostId: 'runtime:box' }
    ])
    expect(producer.rows('box', '2\0runtime-a')).toBeNull()
  })
  it('reads unverifiable after contact returns until a fetch answers again', async () => {
    const { hosts, call, watches, state, publishStatus } = fakeHosts([{ id: 'box', live: true }])
    let answer: (response: RuntimeRpcResponse<unknown>) => void = () => {}
    call.mockResolvedValueOnce(psReply([row('a')]))
    call.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    const producer = new PairedServerRowsProducer({
      hasDemand: () => true,
      hostLabelOverrides: () => new Map()
    })
    producer.attach(hosts)
    watches.get('box')?.onChange()
    await vi.advanceTimersByTimeAsync(0)

    state.servers = [{ id: 'box', live: false }]
    publishStatus()
    state.servers = [{ id: 'box', live: true }]
    publishStatus()
    watches.get('box')?.onChange()
    expect(rowsOf(producer, 'runtime:box')?.freshness).toBe('unverifiable')
    answer(psReply([row('a')]))
    await vi.advanceTimersByTimeAsync(0)
    expect(rowsOf(producer, 'runtime:box')?.freshness).toBe('live')
  })

  it('opens a new watch once the old one ends with its transport, even without a close notice', () => {
    const { hosts, watches, publishStatus } = fakeHosts([{ id: 'box', live: true }])
    const producer = new PairedServerRowsProducer({
      hasDemand: () => true,
      hostLabelOverrides: () => new Map()
    })
    producer.attach(hosts)
    const first = watches.get('box')
    publishStatus()
    expect(watches.get('box')).toBe(first)

    if (first) {
      first.ended = true
    }
    publishStatus()
    expect(watches.get('box')).not.toBe(first)
    expect(first?.closed).toBe(true)
  })
})
