import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RUNTIME_PROTOCOL_VERSION } from '../../../../shared/protocol-version'
import {
  runtimeEnvironmentStatusFromSnapshot,
  type RuntimeHostStatusSnapshot
} from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import type { MobileDesktopRelayHosts } from '../../mobile-desktop-relay/mobile-desktop-relay-hosts'
import { WorktreeRowsChanges } from '../../client/events/worktree-rows-change-events'
import { workspaceChangeOfClientEvent } from '../../mobile-desktop-relay/relay-host-workspace-change'
import { HOST_READ_FLOOR_MS } from '../../../../shared/remote-runtime/host-change-read-gate'
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

function reply(result: unknown): RuntimeRpcResponse<unknown> {
  return { id: 'ps', ok: true, result, _meta: { runtimeId: 'runtime-a' } }
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

function fakeHosts(servers: { id: string; live: boolean; wsl?: true }[]) {
  const state = { servers, pairingRevision: 1 }
  const statusListeners = new Set<() => void>()
  const retiredListeners = new Set<(environmentId: string) => void>()
  const watches = new Map<
    string,
    {
      /** A catalog change unless told otherwise, as reposChanged is. */
      onChange: (change?: { catalog: boolean; live?: true }) => void
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
      environments: state.servers.map(({ id, wsl }) => ({
        id,
        name: id,
        pairingRevision: state.pairingRevision,
        runtimeId: 'runtime-a',
        ...(wsl ? { orcadDeployment: { kind: 'wsl' as const } } : {})
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

/** A change the server announces, read once the floor since the last read passes. */
async function changed(watches: ReturnType<typeof fakeHosts>['watches']): Promise<void> {
  watches.get('box')?.onChange({ catalog: false })
  await vi.advanceTimersByTimeAsync(HOST_READ_FLOOR_MS)
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
    await vi.advanceTimersByTimeAsync(HOST_READ_FLOOR_MS)

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
    await changed(watches)
    expect(rowsOf(producer, 'runtime:box')).toMatchObject({
      freshness: 'unverifiable',
      rows: [{ worktreeId: 'a' }]
    })

    call.mockResolvedValueOnce(psReply([row('a')]))
    await changed(watches)
    expect(rowsOf(producer, 'runtime:box')?.freshness).toBe('live')

    state.servers = [{ id: 'box', live: false }]
    publishStatus()
    expect(watches.get('box')?.closed).toBe(true)
    expect(rowsOf(producer, 'runtime:box')).toMatchObject({
      freshness: 'unverifiable',
      rows: [{ worktreeId: 'a' }]
    })
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
    watches.get('box')?.onChange({ catalog: true, live: true })
    await vi.advanceTimersByTimeAsync(HOST_READ_FLOOR_MS)
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
    watches.get('box')?.onChange({ catalog: true, live: true })
    answerBefore(psReply([row('deleted-during-gap')]))
    await vi.advanceTimersByTimeAsync(HOST_READ_FLOOR_MS)
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

  describe('agent row changes', () => {
    function attached(demand = { on: true }) {
      const fake = fakeHosts([{ id: 'box', live: true }])
      const producer = new PairedServerRowsProducer({
        hasDemand: () => demand.on,
        hostLabelOverrides: () => new Map()
      })
      producer.attach(fake.hosts)
      const ids = () => rowsOf(producer, 'runtime:box')?.rows.map((entry) => entry.worktreeId)
      const snapshotParams = () =>
        fake.call.mock.calls.map(
          ([, , params]) =>
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worktree.ps params are the producer's own object.
            (params as { afterSnapshotId?: string | null }).afterSnapshotId
        )
      return { ...fake, producer, ids, snapshotParams }
    }

    it('reads the server within 2 s of a status change, once for a burst of them', async () => {
      const { call, watches } = attached()
      call.mockResolvedValue(psReply([row('a')]))
      watches.get('box')?.onChange()
      await vi.advanceTimersByTimeAsync(HOST_READ_FLOOR_MS)
      call.mockClear()
      // The server's own emitter, delivered over the client-event stream the watch reads.
      const server = new WorktreeRowsChanges((event) => {
        const change = workspaceChangeOfClientEvent(event)
        if (change) {
          watches.get('box')?.onChange(change)
        }
      })

      // An agent steps every 100 ms for 1.5 s.
      for (let step = 0; step < 15; step += 1) {
        server.changed()
        await vi.advanceTimersByTimeAsync(100)
      }
      expect(call).toHaveBeenCalledTimes(0)
      await vi.advanceTimersByTimeAsync(500)
      expect(call).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(10_000)
      expect(call).toHaveBeenCalledTimes(1)
    })

    it('reads a server once per floor across notices, catalog changes, consumer reads and the backstop', async () => {
      const { call, watches, producer } = attached()
      call.mockResolvedValue(psReply([row('a')]))
      await vi.advanceTimersByTimeAsync(FALLBACK_REFRESH_MS - 1_000)
      watches.get('box')?.onChange()
      await vi.advanceTimersByTimeAsync(0)
      expect(call).toHaveBeenCalledTimes(1)

      watches.get('box')?.onChange({ catalog: false })
      watches.get('box')?.onChange({ catalog: true })
      producer.snapshot()
      // The 30 s backstop comes due here too.
      await vi.advanceTimersByTimeAsync(1_000)
      watches.get('box')?.onChange({ catalog: false })
      expect(call).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(HOST_READ_FLOOR_MS)
      expect(call).toHaveBeenCalledTimes(2)
    })

    it("settles a reader's own read once it answers, though a change lands while it is out and nobody watches", async () => {
      const { call, watches, producer } = attached({ on: false })
      let answer: (response: RuntimeRpcResponse<unknown>) => void = () => {}
      call.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
      let settled = false
      void producer.refresh('box').then(() => (settled = true))
      expect(call).toHaveBeenCalledTimes(1)

      watches.get('box')?.onChange({ catalog: false })
      answer(psReply([row('a')]))
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(true)
    })

    it('applies added, changed and removed rows from a delta, and skips an unchanged reply', async () => {
      const { call, watches, producer, ids, snapshotParams } = attached()
      call.mockResolvedValueOnce(
        reply({ worktrees: [row('a'), row('b'), row('c')], snapshotId: 's1' })
      )
      watches.get('box')?.onChange()
      await vi.advanceTimersByTimeAsync(0)

      call.mockResolvedValueOnce(
        reply({
          snapshotId: 's2',
          baseSnapshotId: 's1',
          rowsFromBase: [0, row('b', { displayName: 'b renamed' }), row('d')]
        })
      )
      await changed(watches)
      expect(ids()).toEqual(['a', 'b', 'd'])
      expect(rowsOf(producer, 'runtime:box')?.rows[1]?.displayName).toBe('b renamed')

      const revision = producer.snapshot().revision
      call.mockResolvedValueOnce(reply({ unchanged: true, snapshotId: 's2' }))
      await changed(watches)
      expect(producer.snapshot().revision).toBe(revision)
      expect(ids()).toEqual(['a', 'b', 'd'])
      expect(snapshotParams()).toEqual([null, 's1', 's2'])
    })

    it('reads in full when a delta cannot be rebuilt and after a reconnect', async () => {
      const { call, watches, producer, ids, snapshotParams, state, publishStatus } = attached()
      call.mockResolvedValueOnce(reply({ worktrees: [row('a')], snapshotId: 's1' }))
      watches.get('box')?.onChange()
      await vi.advanceTimersByTimeAsync(0)

      // A delta indexing past the held rows answers a base this desktop no longer matches.
      call.mockResolvedValueOnce(
        reply({ snapshotId: 's2', baseSnapshotId: 's1', rowsFromBase: [4] })
      )
      call.mockResolvedValueOnce(reply({ worktrees: [row('x')], snapshotId: 's3' }))
      await changed(watches)
      expect(ids()).toEqual(['x'])

      state.servers = [{ id: 'box', live: false }]
      publishStatus()
      state.servers = [{ id: 'box', live: true }]
      publishStatus()
      call.mockResolvedValueOnce(reply({ worktrees: [row('y')], snapshotId: 's4' }))
      watches.get('box')?.onChange({ catalog: true, live: true })
      await vi.advanceTimersByTimeAsync(HOST_READ_FLOOR_MS)
      expect(ids()).toEqual(['y'])
      expect(rowsOf(producer, 'runtime:box')?.freshness).toBe('live')
      expect(snapshotParams()).toEqual([null, 's1', null, null])
    })

    it('reads nothing for agent notices nobody consumes, then catches up once on the next read', async () => {
      const demand = { on: true }
      const { call, watches, producer, ids } = attached(demand)
      call.mockResolvedValueOnce(psReply([row('a')]))
      watches.get('box')?.onChange()
      await vi.advanceTimersByTimeAsync(0)
      call.mockClear()
      demand.on = false

      for (let step = 0; step < 5; step += 1) {
        watches.get('box')?.onChange({ catalog: false })
        await vi.advanceTimersByTimeAsync(FALLBACK_REFRESH_MS)
      }
      expect(call).not.toHaveBeenCalled()

      demand.on = true
      call.mockResolvedValueOnce(psReply([row('a'), row('b')]))
      producer.snapshot()
      producer.snapshot()
      await vi.advanceTimersByTimeAsync(0)
      expect(call).toHaveBeenCalledTimes(1)
      expect(ids()).toEqual(['a', 'b'])
    })

    it('keeps the reconnect full read when a reply from before the gap lands after it', async () => {
      const { call, watches, snapshotParams, state, publishStatus } = attached()
      call.mockResolvedValueOnce(reply({ worktrees: [row('a')], snapshotId: 's1' }))
      watches.get('box')?.onChange()
      await vi.advanceTimersByTimeAsync(0)

      let answer: (response: RuntimeRpcResponse<unknown>) => void = () => {}
      call.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
      await changed(watches)
      state.servers = [{ id: 'box', live: false }]
      publishStatus()
      state.servers = [{ id: 'box', live: true }]
      publishStatus()
      answer(reply({ worktrees: [row('a')], snapshotId: 's2' }))
      await vi.advanceTimersByTimeAsync(0)

      call.mockResolvedValueOnce(reply({ worktrees: [row('a')], snapshotId: 's2' }))
      await changed(watches)
      expect(snapshotParams()).toEqual([null, 's1', null])
    })

    it('reads an older server in full on every refresh and every 30 s', async () => {
      const { call, watches, producer, ids, snapshotParams } = attached()
      call.mockResolvedValueOnce(psReply([row('a')]))
      watches.get('box')?.onChange()
      await vi.advanceTimersByTimeAsync(0)
      const revision = producer.snapshot().revision

      call.mockResolvedValueOnce(psReply([row('a'), row('b')]))
      await vi.advanceTimersByTimeAsync(FALLBACK_REFRESH_MS)
      expect(ids()).toEqual(['a', 'b'])
      expect(producer.snapshot().revision).toBeGreaterThan(revision)
      expect(snapshotParams()).toEqual([null, null])
    })
  })
})
