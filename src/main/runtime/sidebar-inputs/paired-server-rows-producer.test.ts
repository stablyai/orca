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
    {
      /** A catalog change unless told otherwise, as ready and reposChanged are. */
      onChange: (change?: { catalog: boolean }) => void
      onClose: () => void
      closed: boolean
      ended: boolean
    }
  >()
  // worktree.ps; the catalog reads go to `catalogCall`, unanswered unless a test sets them.
  const call = vi.fn<MobileDesktopRelayHosts['call']>()
  const catalogCall = vi.fn<MobileDesktopRelayHosts['call']>(async (_host, method) => ({
    id: method,
    ok: false,
    error: { code: 'method_not_found', message: method }
  }))
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
    call: (host, method, params, options) =>
      (method === 'worktree.ps' ? call : catalogCall)(host, method, params, options),
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
      const watch = {
        onChange: (change = { catalog: true }) => callbacks.onChange(change),
        onClose: callbacks.onClose,
        closed: false,
        ended: false
      }
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
    catalogCall,
    state,
    watches,
    publishStatus: () => statusListeners.forEach((listener) => listener()),
    retire: (environmentId: string) =>
      retiredListeners.forEach((listener) => listener(environmentId))
  }
}

const GROUP = {
  name: 'school',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
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

  it('never certifies rows live from a fetch that started before a contact gap', async () => {
    const { hosts, call, watches, state, publishStatus } = fakeHosts([{ id: 'box', live: true }])
    let answerBefore: (response: RuntimeRpcResponse<unknown>) => void = () => {}
    let answerAfter: (response: RuntimeRpcResponse<unknown>) => void = () => {}
    call.mockReturnValueOnce(new Promise((resolve) => (answerBefore = resolve)))
    call.mockReturnValueOnce(new Promise((resolve) => (answerAfter = resolve)))
    const producer = new PairedServerRowsProducer({
      hasDemand: () => true,
      hostLabelOverrides: () => new Map()
    })
    producer.attach(hosts)
    watches.get('box')?.onChange()

    state.servers = [{ id: 'box', live: false }]
    publishStatus()
    state.servers = [{ id: 'box', live: true }]
    publishStatus()
    watches.get('box')?.onChange()
    answerBefore(psReply([row('deleted-during-gap')]))
    await vi.advanceTimersByTimeAsync(0)
    expect(call).toHaveBeenCalledTimes(2)
    expect(rowsOf(producer, 'runtime:box')).toMatchObject({
      freshness: 'unverifiable',
      rows: [{ worktreeId: 'deleted-during-gap' }]
    })

    answerAfter(psReply([row('current')]))
    await vi.advanceTimersByTimeAsync(0)
    expect(rowsOf(producer, 'runtime:box')).toMatchObject({
      freshness: 'live',
      rows: [{ worktreeId: 'current' }]
    })
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

  it("reads a server's catalog on contact and on its change events, never on the fallback poll", async () => {
    const { hosts, call, catalogCall, watches } = fakeHosts([{ id: 'box', live: true }])
    call.mockResolvedValue(psReply([]))
    let groupId = 'g1'
    catalogCall.mockImplementation(async (_host, method) => {
      const result =
        method === 'repo.list'
          ? { repos: [{ id: 'r', path: '/srv/r', displayName: 'r', projectGroupId: groupId }] }
          : method === 'projectGroup.list'
            ? { groups: [{ ...GROUP, id: groupId }] }
            : null
      return result
        ? { id: method, ok: true as const, result, _meta: { runtimeId: 'runtime-a' } }
        : { id: method, ok: false as const, error: { code: 'method_not_found', message: method } }
    })
    const producer = new PairedServerRowsProducer({
      hasDemand: () => true,
      hostLabelOverrides: () => new Map()
    })
    producer.attach(hosts)
    const repoListCalls = () =>
      catalogCall.mock.calls.filter(([, method]) => method === 'repo.list')
    watches.get('box')?.onChange()
    await vi.advanceTimersByTimeAsync(0)

    // Stamped as the server's own, and without project.list an older server's projection.
    expect(producer.catalogs()).toEqual([
      {
        hostId: 'runtime:box',
        repos: [expect.objectContaining({ id: 'r', executionHostId: 'runtime:box' })],
        projectGroups: [expect.objectContaining({ id: 'g1', executionHostId: 'runtime:box' })],
        projection: {
          projects: [expect.objectContaining({ sourceRepoIds: ['r'] })],
          setups: [expect.objectContaining({ repoId: 'r', hostId: 'runtime:box' })]
        }
      }
    ])
    await vi.advanceTimersByTimeAsync(FALLBACK_REFRESH_MS)
    expect(call.mock.calls.length).toBeGreaterThan(1)
    expect(repoListCalls()).toHaveLength(1)

    groupId = 'g2'
    watches.get('box')?.onChange()
    await vi.advanceTimersByTimeAsync(0)
    expect(repoListCalls()).toHaveLength(2)
    expect(producer.catalogs()[0]?.repos[0]?.projectGroupId).toBe('g2')
  })

  it('keeps the last catalog through a failed read and reads it again on the next fetch', async () => {
    const { hosts, call, catalogCall, watches } = fakeHosts([{ id: 'box', live: true }])
    call.mockResolvedValue(psReply([]))
    catalogCall.mockResolvedValueOnce({
      id: 'repo.list',
      ok: true,
      result: { repos: [{ id: 'r', path: '/srv/r', displayName: 'r' }] },
      _meta: { runtimeId: 'runtime-a' }
    })
    const producer = new PairedServerRowsProducer({
      hasDemand: () => true,
      hostLabelOverrides: () => new Map()
    })
    producer.attach(hosts)
    watches.get('box')?.onChange()
    await vi.advanceTimersByTimeAsync(0)
    expect(producer.catalogs()[0]?.repos.map((repo) => repo.id)).toEqual(['r'])

    watches.get('box')?.onChange()
    await vi.advanceTimersByTimeAsync(0)
    expect(producer.catalogs()[0]?.repos.map((repo) => repo.id)).toEqual(['r'])
    const reads = catalogCall.mock.calls.length
    // The failed read left it stale, so the poll reads it again.
    await vi.advanceTimersByTimeAsync(FALLBACK_REFRESH_MS)
    expect(catalogCall.mock.calls.length).toBeGreaterThan(reads)
  })

  it('reads no catalog for worktreesChanged, which no catalog write sends alone', async () => {
    const { hosts, call, catalogCall, watches } = fakeHosts([{ id: 'box', live: true }])
    call.mockResolvedValue(psReply([]))
    catalogCall.mockResolvedValue({
      id: 'repo.list',
      ok: true,
      result: { repos: [] },
      _meta: { runtimeId: 'runtime-a' }
    })
    const producer = new PairedServerRowsProducer({
      hasDemand: () => true,
      hostLabelOverrides: () => new Map()
    })
    producer.attach(hosts)
    watches.get('box')?.onChange()
    await vi.advanceTimersByTimeAsync(0)
    const reads = catalogCall.mock.calls.length
    const rowReads = call.mock.calls.length

    watches.get('box')?.onChange({ catalog: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(call.mock.calls.length).toBe(rowReads + 1)
    expect(catalogCall.mock.calls.length).toBe(reads)
  })
})
