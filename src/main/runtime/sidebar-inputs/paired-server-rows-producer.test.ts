import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RUNTIME_PROTOCOL_VERSION } from '../../../shared/protocol-version'
import {
  runtimeEnvironmentStatusFromSnapshot,
  type RuntimeHostStatusSnapshot
} from '../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { SshConnectionState } from '../../../shared/ssh-types'
import type { MobileDesktopRelayHosts } from '../mobile-desktop-relay/mobile-desktop-relay-hosts'
import { PairedServerRowsProducer } from './paired-server-rows-producer'

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

function fakeHosts(servers: { id: string; live: boolean; wsl?: true }[]) {
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
})
