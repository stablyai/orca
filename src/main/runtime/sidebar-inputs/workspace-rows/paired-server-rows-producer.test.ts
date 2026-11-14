import '../../../../shared/remote-runtime/host-store/environment-store-worker-test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodePairingOffer } from '../../../../shared/remote-runtime/pairing/pairing'
import {
  addEnvironmentFromPairingCode,
  resolveEnvironment,
  updateEnvironmentFromPairingCode
} from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RUNTIME_PROTOCOL_VERSION } from '../../../../shared/protocol-version'
import {
  runtimeEnvironmentStatusFromSnapshot,
  type RuntimeHostStatusSnapshot
} from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import type { MobileDesktopRelayHosts } from '../../mobile-desktop-relay/mobile-desktop-relay-hosts'
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
  const statusListeners = new Set<Parameters<MobileDesktopRelayHosts['onStatusChanged']>[0]>()
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
    publishStatus: () => {
      for (const server of state.servers) {
        statusListeners.forEach((listener) =>
          listener({ environmentId: server.id, inContact: server.live })
        )
      }
    },
    retire: (environmentId: string) =>
      retiredListeners.forEach((listener) => listener(environmentId))
  }
}

async function rowsOf(producer: PairedServerRowsProducer, hostId: string) {
  return (await producer.snapshot()).servers.find((server) => server.hostId === hostId)
}

describe('PairedServerRowsProducer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([10, 100])(
    'coalesces %i status invalidations without publishing unchanged facts',
    async (count) => {
      const h = fakeHosts([{ id: 'box', live: false }])
      const producer = new PairedServerRowsProducer({
        hasDemand: () => false,
        hostLabelOverrides: () => new Map()
      })
      const original = h.hosts.list
      const list = vi.spyOn(h.hosts, 'list')
      const detach = producer.attach(h.hosts)
      await producer.sync()
      await vi.advanceTimersByTimeAsync(0)
      const before = producer.revision.value
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      list.mockImplementationOnce(async () => {
        await gate
        return original()
      })
      list.mockClear()
      h.publishStatus()
      for (let i = 0; i < count; i++) {
        h.publishStatus()
      }
      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(list.mock.calls.length).toBeLessThanOrEqual(2)
      expect(producer.revision.value).toBe(before)
      h.state.servers = [{ id: 'renamed', live: false }]
      h.publishStatus()
      await vi.advanceTimersByTimeAsync(0)
      expect((await producer.snapshot()).servers.map((server) => server.host?.label)).toEqual([
        'renamed'
      ])
      expect(producer.revision.value).toBeGreaterThan(before)
      detach()
      list.mockRestore()
    }
  )

  it.each([10, 100])(
    'keeps other hosts confirmed on a same-health publication across %i hosts',
    async (count) => {
      const h = fakeHosts(Array.from({ length: count }, (_, i) => ({ id: `box-${i}`, live: true })))
      h.call.mockResolvedValue(psReply([row('workspace')]))
      const producer = new PairedServerRowsProducer({
        hasDemand: () => false,
        hostLabelOverrides: () => new Map()
      })
      const detach = producer.attach(h.hosts)
      await producer.sync()
      await vi.advanceTimersByTimeAsync(0)
      for (const watch of h.watches.values()) {
        watch.onChange()
      }
      await vi.advanceTimersByTimeAsync(0)
      h.call.mockImplementation(() => new Promise(() => {}))
      h.publishStatus()
      await producer.sync()
      expect(
        (await producer.snapshot()).servers.every((server) => server.freshness === 'live')
      ).toBe(true)
      detach()
    }
  )

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
    await producer.sync()
    await vi.advanceTimersByTimeAsync(0)
    watches.get('box')?.onChange()
    watches.get('box')?.onChange()
    watches.get('box')?.onChange()
    answer(psReply([row('old')]))
    await vi.advanceTimersByTimeAsync(0)

    expect((await rowsOf(producer, 'runtime:box'))?.rows.map((entry) => entry.worktreeId)).toEqual([
      'new'
    ])
  })

  it('keeps the last rows as unverifiable when the server loses contact or stops answering', async () => {
    const { hosts, call, watches, state, publishStatus } = fakeHosts([{ id: 'box', live: true }])
    call.mockResolvedValueOnce(psReply([row('a')]))
    const producer = new PairedServerRowsProducer({
      hasDemand: () => true,
      hostLabelOverrides: () => new Map()
    })
    producer.attach(hosts)
    await producer.sync()
    await vi.advanceTimersByTimeAsync(0)
    watches.get('box')?.onChange()
    await vi.advanceTimersByTimeAsync(0)

    call.mockRejectedValueOnce(new Error('timeout'))
    await producer.refresh('box')
    expect(await rowsOf(producer, 'runtime:box')).toMatchObject({
      freshness: 'unverifiable',
      rows: [{ worktreeId: 'a' }]
    })

    call.mockResolvedValueOnce(psReply([row('a')]))
    await producer.refresh('box')
    expect((await rowsOf(producer, 'runtime:box'))?.freshness).toBe('live')

    state.servers = [{ id: 'box', live: false }]
    publishStatus()
    await producer.sync()
    await vi.advanceTimersByTimeAsync(0)
    expect(watches.get('box')?.closed).toBe(true)
    expect(await rowsOf(producer, 'runtime:box')).toMatchObject({
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
    await producer.sync()
    await vi.advanceTimersByTimeAsync(0)
    watches.get('box')?.onChange()

    state.pairingRevision = 2
    retire('box')
    answer(psReply([row('old-pairing')]))
    await vi.advanceTimersByTimeAsync(0)
    expect(await rowsOf(producer, 'runtime:box')).toEqual({
      hostId: 'runtime:box',
      freshness: 'unverifiable',
      host: { label: 'box', health: 'available', compatibility: 'ok', pairedDeviceId: null },
      rows: []
    })

    state.servers = []
    retire('box')
    expect((await producer.snapshot()).servers).toEqual([])
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
    await producer.sync()
    await vi.advanceTimersByTimeAsync(0)
    watches.get('box')?.onChange()
    await vi.advanceTimersByTimeAsync(0)

    state.servers = [{ id: 'box', live: false }]
    publishStatus()
    await producer.sync()
    await vi.advanceTimersByTimeAsync(0)
    state.servers = [{ id: 'box', live: true }]
    publishStatus()
    await producer.sync()
    await vi.advanceTimersByTimeAsync(0)
    expect((await rowsOf(producer, 'runtime:box'))?.freshness).toBe('unverifiable')
    answer(psReply([row('a')]))
    await vi.advanceTimersByTimeAsync(0)
    expect((await rowsOf(producer, 'runtime:box'))?.freshness).toBe('live')
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
    await producer.sync()
    await vi.advanceTimersByTimeAsync(0)
    watches.get('box')?.onChange()

    state.servers = [{ id: 'box', live: false }]
    publishStatus()
    await producer.sync()
    await vi.advanceTimersByTimeAsync(0)
    state.servers = [{ id: 'box', live: true }]
    publishStatus()
    await producer.sync()
    await vi.advanceTimersByTimeAsync(0)
    watches.get('box')?.onChange()
    answerBefore(psReply([row('deleted-during-gap')]))
    await vi.advanceTimersByTimeAsync(0)
    expect(await rowsOf(producer, 'runtime:box')).toMatchObject({
      freshness: 'unverifiable',
      rows: [{ worktreeId: 'deleted-during-gap' }]
    })

    answerAfter(psReply([row('current')]))
    await vi.advanceTimersByTimeAsync(0)
    expect(await rowsOf(producer, 'runtime:box')).toMatchObject({
      freshness: 'live',
      rows: [{ worktreeId: 'current' }]
    })
  })
})

it('closes a delayed watch from a detached provider without resurrecting its hosts', async () => {
  const old = fakeHosts([{ id: 'old', live: true }])
  const next = fakeHosts([{ id: 'new', live: false }])
  let release!: (watch: { close(): void; current(): boolean }) => void
  let closed = false
  old.hosts.watchChanges = () =>
    new Promise((resolve) => {
      release = resolve
    })
  const producer = new PairedServerRowsProducer({
    hasDemand: () => true,
    hostLabelOverrides: () => new Map()
  })
  const detach = producer.attach(old.hosts)
  await producer.sync()
  await Promise.resolve()
  detach()
  const detachNext = producer.attach(next.hosts)
  try {
    await producer.sync()
    release({
      close: () => {
        closed = true
      },
      current: () => !closed
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(closed).toBe(true)
    expect((await producer.snapshot()).servers.map((server) => server.hostId)).toEqual([
      'runtime:new'
    ])
  } finally {
    detachNext()
  }
})

it('publishes a fresh complete listing after a pairing changes between its store reads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-paired-listing-'))
  const code = (seed: number) =>
    encodePairingOffer({
      v: 2,
      publicKeyB64: Buffer.alloc(32, seed).toString('base64'),
      deviceToken: `synthetic-${seed}`,
      endpoint: 'wss://pairing.example.com/runtime'
    })
  const saved = await addEnvironmentFromPairingCode(root, {
    name: 'Box',
    pairingCode: code(1),
    now: 100
  })
  const h = fakeHosts([{ id: saved.id, live: false }])
  const original = h.hosts.list
  const producer = new PairedServerRowsProducer({
    hasDemand: () => false,
    hostLabelOverrides: () => new Map()
  })
  const detach = producer.attach(h.hosts)
  try {
    await producer.sync()
    await new Promise<void>((resolve) => setImmediate(resolve))
    const listing = async () => {
      const record = await resolveEnvironment(root, saved.id)
      const result = await original()
      return {
        ...result,
        environments: result.environments.map((environment) => ({
          ...environment,
          name: `Pairing ${record.pairingRevision}`
        }))
      }
    }
    vi.spyOn(h.hosts, 'list')
      .mockImplementation(listing)
      .mockImplementationOnce(async () => {
        const stale = await listing()
        await updateEnvironmentFromPairingCode(root, saved.id, { pairingCode: code(2), now: 200 })
        await resolveEnvironment(root, saved.id)
        return stale
      })
    const published: string[][] = []
    await producer.withPreparedSnapshot((snapshot) => {
      published.push(snapshot.servers.map((server) => server.host!.label))
    })
    expect(published).toEqual([['Pairing 200']])
  } finally {
    detach()
    rmSync(root, { recursive: true, force: true })
  }
})
