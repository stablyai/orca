import { describe, expect, it, vi } from 'vitest'
import { DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY } from '../../../shared/delegated-mobile-device-contract'
import { RUNTIME_PROTOCOL_VERSION } from '../../../shared/protocol-version'
import {
  runtimeEnvironmentStatusFromSnapshot,
  type RuntimeHostStatusSnapshot
} from '../../../shared/runtime-host-status'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { SshConnectionState } from '../../../shared/ssh-types'
import type { MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'
import { MobileRelayHostCatalog } from './mobile-relay-host-catalog'

function answer(capable: boolean): RuntimeStatus {
  return {
    runtimeId: 'runtime-a',
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    capabilities: capable ? [DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY] : []
  }
}

function snapshot(
  environmentId: string,
  contact: 'live' | 'unreachable' | 'never-answered',
  capable = true
): RuntimeHostStatusSnapshot {
  return {
    environmentId,
    pairingRevision: 1,
    sequence: 1,
    checkedAt: 1,
    status: contact === 'never-answered' ? null : answer(capable),
    verification: contact === 'live' ? 'verified' : 'unavailable',
    transport: contact === 'live' ? 'ready' : 'disconnected'
  }
}

function psReply(rows: Record<string, unknown>[]): RuntimeRpcResponse<unknown> {
  return {
    id: 'ps',
    ok: true,
    result: { worktrees: rows, totalCount: rows.length, truncated: false },
    _meta: { runtimeId: 'runtime-a' }
  }
}

function fakeHosts(
  environments: {
    id: string
    name: string
    snapshot: RuntimeHostStatusSnapshot
    orcadDeployment?: { sshTargetId: string }
    runtimeId?: string | null
  }[]
) {
  const state = {
    environments,
    pairingRevision: 1,
    retire: (_environmentId: string) => {},
    sshTargetLabels: new Map<string, string>(),
    sshConnectionStates: new Map<string, SshConnectionState>()
  }
  const call = vi.fn<MobileDesktopRelayHosts['call']>()
  const hosts: MobileDesktopRelayHosts = {
    list: () => ({
      environments: state.environments.map(({ id, name, orcadDeployment, runtimeId }) => ({
        id,
        name,
        orcadDeployment,
        pairingRevision: state.pairingRevision,
        runtimeId: runtimeId === undefined ? 'runtime-a' : runtimeId
      })),
      sshTargetLabels: state.sshTargetLabels,
      sshConnectionStates: state.sshConnectionStates,
      statusByEnvironmentId: new Map(
        state.environments.map((entry) => [
          entry.id,
          runtimeEnvironmentStatusFromSnapshot(entry.snapshot)
        ])
      )
    }),
    resolve: async (environmentId) => ({
      environmentId,
      fence: 'unused',
      pairing: { v: 2, endpoint: 'ws://server', deviceToken: 'desktop', publicKeyB64: 'k' }
    }),
    call,
    onEnvironmentRetired: (listener) => {
      state.retire = listener
      return () => {}
    }
  }
  return { hosts, call, state }
}

function catalog(hosts: MobileDesktopRelayHosts, labels = new Map()) {
  let now = 1_000
  return {
    catalog: new MobileRelayHostCatalog({
      hosts,
      hostLabelOverrides: () => labels,
      now: () => now
    }),
    advance: (ms: number) => {
      now += ms
    }
  }
}

describe('mobile relay host catalog', () => {
  it("lists every configured server with the desktop's health and whether it can relay", async () => {
    const { hosts, call } = fakeHosts([
      { id: 'ready', name: 'Box', snapshot: snapshot('ready', 'live') },
      { id: 'old', name: 'ThinkPad', snapshot: snapshot('old', 'live', false) },
      { id: 'down', name: 'VM', snapshot: snapshot('down', 'unreachable') },
      { id: 'old-down', name: 'Pi', snapshot: snapshot('old-down', 'unreachable', false) },
      { id: 'new', name: 'Fresh', snapshot: snapshot('new', 'never-answered') }
    ])
    call.mockResolvedValue(psReply([]))
    const { catalog: hostCatalog } = catalog(hosts, new Map([['runtime:ready', 'Build box']]))

    expect(hostCatalog.list().hosts).toEqual([
      { hostId: 'runtime:ready', label: 'Build box', health: 'available', relay: 'ready' },
      { hostId: 'runtime:old', label: 'ThinkPad', health: 'available', relay: 'update-needed' },
      { hostId: 'runtime:down', label: 'VM', health: 'connecting', relay: 'unavailable' },
      // A build's capabilities outlive contact, so an old server stays update-needed offline.
      { hostId: 'runtime:old-down', label: 'Pi', health: 'connecting', relay: 'update-needed' },
      { hostId: 'runtime:new', label: 'Fresh', health: 'connecting', relay: 'unavailable' }
    ])
    // Listing reads what the desktop already knows; it never contacts a server.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(call).not.toHaveBeenCalled()
  })

  it("lists a managed server once, under its SSH host's name and rename, as the sidebar does", async () => {
    const { hosts, state } = fakeHosts([
      {
        id: 'managed',
        name: 'orcad on devbox',
        snapshot: snapshot('managed', 'live'),
        orcadDeployment: { sshTargetId: 'devbox' }
      }
    ])
    state.sshTargetLabels.set('devbox', 'Dev Box')
    expect(catalog(hosts).catalog.list().hosts).toEqual([
      { hostId: 'runtime:managed', label: 'Dev Box', health: 'available', relay: 'ready' }
    ])
    const renamed = catalog(hosts, new Map([['ssh:devbox', 'Build box']])).catalog
    expect(renamed.list().hosts.map((host) => host.label)).toEqual(['Build box'])
  })

  it('does not list a managed server while its SSH host is reached over the SSH relay', () => {
    const { hosts, state } = fakeHosts([
      {
        id: 'managed',
        name: 'orcad on devbox',
        snapshot: snapshot('managed', 'live'),
        orcadDeployment: { sshTargetId: 'devbox' }
      },
      { id: 'other', name: 'Box', snapshot: snapshot('other', 'live') }
    ])
    state.sshTargetLabels.set('devbox', 'Dev Box')
    state.sshConnectionStates.set('devbox', {
      targetId: 'devbox',
      status: 'connected',
      error: null,
      reconnectAttempt: 0,
      managedServer: { kind: 'relay', reason: 'relay_terminals_live' }
    })
    // Its workspaces are the SSH host's, which the desktop already lists to the phone itself.
    expect(
      catalog(hosts)
        .catalog.list()
        .hosts.map((host) => host.hostId)
    ).toEqual(['runtime:other'])
  })

  it('encodes an environment id into the host id the desktop uses', () => {
    const { hosts } = fakeHosts([
      { id: 'a b', name: 'Spaced', snapshot: snapshot('a b', 'unreachable') }
    ])
    expect(catalog(hosts).catalog.list().hosts[0]?.hostId).toBe('runtime:a%20b')
  })

  it("serves a server's rows fetched as the desktop, re-stamped with the server's host id", async () => {
    const { hosts, call } = fakeHosts([
      { id: 'env', name: 'Box', snapshot: snapshot('env', 'live') }
    ])
    call.mockResolvedValue(
      psReply([
        { worktreeId: 'w-local', hostId: 'local', status: 'working' },
        { worktreeId: 'w-ssh', hostId: 'ssh:devbox', status: 'inactive' },
        { worktreeId: 'w-legacy', status: 'done' }
      ])
    )
    const { catalog: hostCatalog } = catalog(hosts)

    await expect(hostCatalog.worktrees('runtime:env')).resolves.toEqual({
      worktrees: [
        { worktreeId: 'w-local', hostId: 'runtime:env', status: 'working' },
        { worktreeId: 'w-ssh', hostId: 'runtime:env', status: 'inactive' },
        { worktreeId: 'w-legacy', hostId: 'runtime:env', status: 'done' }
      ],
      totalCount: 3,
      truncated: false,
      fetchedAt: 1_000,
      stale: false
    })
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'env' }),
      'worktree.ps',
      // The phone's full-catalog limit: the server's default page would silently truncate.
      { limit: 10_000, supportsWorktreeVisibilitySourceDefaults: true },
      { timeoutMs: 5_000, expected: { pairingRevision: 1, runtimeId: 'runtime-a' } }
    )
  })

  it('keeps the last rows, unchanged and marked stale, once the server stops answering', async () => {
    const { hosts, call, state } = fakeHosts([
      { id: 'env', name: 'Box', snapshot: snapshot('env', 'live') }
    ])
    call.mockResolvedValue(psReply([{ worktreeId: 'w', hostId: 'local', status: 'working' }]))
    const { catalog: hostCatalog, advance } = catalog(hosts)
    await hostCatalog.worktrees('runtime:env')
    advance(5_000)

    state.environments = [{ id: 'env', name: 'Box', snapshot: snapshot('env', 'unreachable') }]
    const offline = await hostCatalog.worktrees('runtime:env')
    // Never re-fetched while the desktop itself cannot reach it, and never rewritten as idle.
    expect(call).toHaveBeenCalledTimes(1)
    expect(offline).toEqual({
      worktrees: [{ worktreeId: 'w', hostId: 'runtime:env', status: 'working' }],
      totalCount: 1,
      truncated: false,
      fetchedAt: 1_000,
      stale: true
    })

    // A failed fetch on a server that looks reachable also serves the last rows as stale.
    state.environments = [{ id: 'env', name: 'Box', snapshot: snapshot('env', 'live') }]
    call.mockRejectedValueOnce(new Error('socket closed'))
    await expect(hostCatalog.worktrees('runtime:env')).resolves.toMatchObject({
      fetchedAt: 1_000,
      stale: true
    })
  })

  it('omits rows mid-delete, as a phone asking the server itself would never see them', async () => {
    const { hosts, call } = fakeHosts([
      { id: 'env', name: 'Box', snapshot: snapshot('env', 'live') }
    ])
    call.mockResolvedValue({
      id: 'ps',
      ok: true,
      result: {
        worktrees: [
          { worktreeId: 'kept', hostId: 'local' },
          { worktreeId: 'deleting', hostId: 'local', removing: true }
        ],
        totalCount: 5,
        truncated: true
      },
      _meta: { runtimeId: 'runtime-a' }
    })
    await expect(catalog(hosts).catalog.worktrees('runtime:env')).resolves.toMatchObject({
      worktrees: [{ worktreeId: 'kept', hostId: 'runtime:env' }],
      totalCount: 4,
      truncated: true
    })
  })

  it('lists an update-needed server live, since the desktop itself can still reach it', async () => {
    const { hosts, call } = fakeHosts([
      { id: 'old', name: 'ThinkPad', snapshot: snapshot('old', 'live', false) }
    ])
    call.mockResolvedValue(psReply([{ worktreeId: 'w', hostId: 'local' }]))
    await expect(catalog(hosts).catalog.worktrees('runtime:old')).resolves.toMatchObject({
      worktrees: [{ worktreeId: 'w', hostId: 'runtime:old' }],
      stale: false
    })
  })

  it('has no rows for a server never fetched, an unknown host, or rows from before a re-pair', async () => {
    const { hosts, call, state } = fakeHosts([
      { id: 'env', name: 'Box', snapshot: snapshot('env', 'unreachable') }
    ])
    const { catalog: hostCatalog } = catalog(hosts)
    await expect(hostCatalog.worktrees('runtime:env')).resolves.toEqual({ worktrees: null })
    await expect(hostCatalog.worktrees('runtime:other')).resolves.toEqual({ worktrees: null })
    await expect(hostCatalog.worktrees('ssh:env')).resolves.toEqual({ worktrees: null })

    state.environments = [{ id: 'env', name: 'Box', snapshot: snapshot('env', 'live') }]
    call.mockResolvedValue(psReply([{ worktreeId: 'w', hostId: 'local' }]))
    await hostCatalog.worktrees('runtime:env')
    state.pairingRevision = 2
    state.environments = [{ id: 'env', name: 'Box', snapshot: snapshot('env', 'unreachable') }]
    await expect(hostCatalog.worktrees('runtime:env')).resolves.toEqual({ worktrees: null })
  })

  it('has no rows when re-paired mid-fetch, and the next poll fetches the new server afresh', async () => {
    const { hosts, call, state } = fakeHosts([
      { id: 'env', name: 'Box', snapshot: snapshot('env', 'live') }
    ])
    let answerOldFetch: (response: RuntimeRpcResponse<unknown>) => void = () => {}
    call.mockReturnValueOnce(new Promise((resolve) => (answerOldFetch = resolve)))
    const { catalog: hostCatalog } = catalog(hosts)
    const rows = hostCatalog.worktrees('runtime:env')
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    state.pairingRevision = 2
    call.mockResolvedValueOnce(psReply([{ worktreeId: 'new-server-row', hostId: 'local' }]))
    // Never joins the old server's fetch, still pending here.
    const next = hostCatalog.worktrees('runtime:env')
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    expect(call).toHaveBeenLastCalledWith(expect.anything(), 'worktree.ps', expect.anything(), {
      timeoutMs: 5_000,
      expected: { pairingRevision: 2, runtimeId: 'runtime-a' }
    })
    await expect(next).resolves.toMatchObject({ worktrees: [{ worktreeId: 'new-server-row' }] })
    answerOldFetch(psReply([{ worktreeId: 'old-server-row', hostId: 'local' }]))
    await expect(rows).resolves.toEqual({ worktrees: null })
  })

  it("forgets a removed server's rows, even ones its last fetch delivers after removal", async () => {
    const { hosts, call, state } = fakeHosts([
      { id: 'env', name: 'Box', snapshot: snapshot('env', 'live') }
    ])
    let answerFetch: (response: RuntimeRpcResponse<unknown>) => void = () => {}
    call.mockReturnValue(new Promise((resolve) => (answerFetch = resolve)))
    const { catalog: hostCatalog } = catalog(hosts)
    const rows = hostCatalog.worktrees('runtime:env')
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    const removed = state.environments
    state.environments = []
    state.retire('env')
    answerFetch(psReply([{ worktreeId: 'w', hostId: 'local' }]))
    await expect(rows).resolves.toEqual({ worktrees: null })
    expect(hostCatalog.list().hosts).toEqual([])
    // Added back under the same id and identity: the late rows were pruned, not kept.
    state.environments = [{ ...removed[0]!, snapshot: snapshot('env', 'unreachable') }]
    await expect(hostCatalog.worktrees('runtime:env')).resolves.toEqual({ worktrees: null })
  })

  it('keeps the last rows, stale, for a server manually disconnected but still configured', async () => {
    const { hosts, call, state } = fakeHosts([
      { id: 'env', name: 'Box', snapshot: snapshot('env', 'live') }
    ])
    call.mockResolvedValue(psReply([{ worktreeId: 'w', hostId: 'local' }]))
    const { catalog: hostCatalog } = catalog(hosts)
    await hostCatalog.worktrees('runtime:env')
    // A manual disconnect retires the desktop's transport and its status owner.
    state.environments = [
      {
        id: 'env',
        name: 'Box',
        snapshot: { ...snapshot('env', 'unreachable'), retired: true, verification: 'blocked' }
      }
    ]
    state.retire('env')
    await expect(hostCatalog.worktrees('runtime:env')).resolves.toMatchObject({
      worktrees: [{ worktreeId: 'w', hostId: 'runtime:env' }],
      stale: true
    })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('lists a server whose runtime id the desktop has not recorded yet', async () => {
    const { hosts, call } = fakeHosts([
      { id: 'env', name: 'Box', snapshot: snapshot('env', 'live'), runtimeId: null }
    ])
    call.mockResolvedValue(psReply([{ worktreeId: 'w', hostId: 'local' }]))
    await expect(catalog(hosts).catalog.worktrees('runtime:env')).resolves.toMatchObject({
      worktrees: [{ worktreeId: 'w' }],
      stale: false
    })
    expect(call).toHaveBeenCalledWith(expect.anything(), 'worktree.ps', expect.anything(), {
      timeoutMs: 5_000,
      expected: { pairingRevision: 1, runtimeId: null }
    })
  })

  it('answers with the last rows, marked stale, when the server never answers the fetch', async () => {
    vi.useFakeTimers()
    try {
      const { hosts, call } = fakeHosts([
        { id: 'env', name: 'Box', snapshot: snapshot('env', 'live') }
      ])
      call.mockResolvedValueOnce(psReply([{ worktreeId: 'w', hostId: 'local' }]))
      const { catalog: hostCatalog } = catalog(hosts)
      await hostCatalog.worktrees('runtime:env')
      call.mockReturnValue(new Promise(() => {}))
      let settled = false
      const rows = hostCatalog.worktrees('runtime:env').finally(() => (settled = true))
      await vi.advanceTimersByTimeAsync(4_999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(rows).resolves.toMatchObject({
        worktrees: [{ worktreeId: 'w', hostId: 'runtime:env' }],
        fetchedAt: 1_000,
        stale: true
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('shares one in-flight fetch per server between concurrent rows requests', async () => {
    const { hosts, call } = fakeHosts([
      { id: 'env', name: 'Box', snapshot: snapshot('env', 'live') }
    ])
    let answerFetch: (response: RuntimeRpcResponse<unknown>) => void = () => {}
    call.mockReturnValue(new Promise((resolve) => (answerFetch = resolve)))
    const { catalog: hostCatalog } = catalog(hosts)
    const first = hostCatalog.worktrees('runtime:env')
    const second = hostCatalog.worktrees('runtime:env')
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    answerFetch(psReply([{ worktreeId: 'w', hostId: 'local' }]))
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { stale: false },
      { stale: false }
    ])
    expect(call).toHaveBeenCalledTimes(1)
  })
})
