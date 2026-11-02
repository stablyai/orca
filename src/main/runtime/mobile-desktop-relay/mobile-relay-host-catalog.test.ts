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
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type { Tab } from '../../../shared/tab-types'
import type { MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'
import { MobileRelayHostCatalog } from './mobile-relay-host-catalog'
import { PairedServerRowsProducer } from '../sidebar-inputs/paired-server-rows-producer'

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
    orcadDeployment?: { sshTargetId: string } | { kind: 'wsl' }
    runtimeId?: string | null
    pairedDeviceId?: string
    stoppedOnDesktop?: true
    unavailableOnDesktop?: true
  }[]
) {
  const state = {
    environments,
    pairingRevision: 1,
    retire: (_environmentId: string) => {},
    sshTargetLabels: new Map<string, string>(),
    sshConnectionStates: new Map<string, SshConnectionState>()
  }
  // Simulate an older server answering only worktree.ps, leaving producer catalog reads pending.
  const call = vi.fn<MobileDesktopRelayHosts['call']>()
  const hosts: MobileDesktopRelayHosts = {
    list: () => ({
      environments: state.environments.map(
        ({
          id,
          name,
          orcadDeployment,
          runtimeId,
          pairedDeviceId,
          stoppedOnDesktop,
          unavailableOnDesktop
        }) => ({
          id,
          name,
          orcadDeployment,
          stoppedOnDesktop,
          unavailableOnDesktop,
          pairingRevision: state.pairingRevision,
          runtimeId: runtimeId === undefined ? 'runtime-a' : runtimeId,
          pairedDeviceId
        })
      ),
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
    call: (host, method, params, options) =>
      method === 'worktree.ps'
        ? call(host, method, params, options)
        : Promise.reject(new Error('method_not_found')),
    hostsBrowserPage: () => false,
    onEnvironmentRetired: (listener) => {
      state.retire = listener
      return () => {}
    },
    onStatusChanged: () => () => {},
    watchChanges: () => ({ close: () => {}, current: () => true })
  }
  return { hosts, call, state }
}

function catalog(
  hosts: MobileDesktopRelayHosts,
  labels = new Map(),
  desktop: {
    sessions?: Record<string, Partial<WorkspaceSessionState>>
  } = {}
) {
  const serverRows = new PairedServerRowsProducer({
    hasDemand: () => false,
    hostLabelOverrides: () => new Map()
  })
  serverRows.attach(hosts)
  return {
    catalog: new MobileRelayHostCatalog({
      hosts,
      serverRows,
      hostLabelOverrides: () => labels,
      getWorkspaceSession: (hostId) => {
        const session = desktop.sessions?.[hostId]
        return session ? { ...getDefaultWorkspaceSession(), ...session } : null
      }
    })
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
      // Build capabilities remain known while offline.
      { hostId: 'runtime:old-down', label: 'Pi', health: 'connecting', relay: 'update-needed' },
      { hostId: 'runtime:new', label: 'Fresh', health: 'connecting', relay: 'unavailable' }
    ])
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

  it('marks a WSL host stopped on the desktop only once the desktop confirmed the stop', () => {
    const wsl = {
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      snapshot: snapshot('wsl:ubuntu', 'unreachable'),
      orcadDeployment: { kind: 'wsl' as const }
    }
    const unconfirmed = {
      hostId: 'runtime:wsl%3Aubuntu',
      label: 'Ubuntu (WSL)',
      health: 'connecting',
      relay: 'unavailable'
    }
    expect(catalog(fakeHosts([wsl]).hosts).catalog.list().hosts).toEqual([unconfirmed])
    const stopped = fakeHosts([{ ...wsl, stoppedOnDesktop: true }]).hosts
    expect(catalog(stopped).catalog.list().hosts).toEqual([
      { ...unconfirmed, stoppedOnDesktop: true }
    ])
    const notConnected = fakeHosts([{ ...wsl, unavailableOnDesktop: true }]).hosts
    expect(catalog(notConnected).catalog.list().hosts).toEqual([
      { ...unconfirmed, unavailableOnDesktop: true }
    ])
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
    // The phone already lists these workspaces under the SSH host.
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
      ]
    })
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'env' }),
      'worktree.ps',
      // Default server pagination would silently truncate the full catalog.
      { limit: 10_000, supportsWorktreeVisibilitySourceDefaults: true },
      { expected: { pairingRevision: 1, runtimeId: 'runtime-a' } }
    )
  })

  it('keeps the last rows, unchanged, once the server stops answering', async () => {
    const { hosts, call, state } = fakeHosts([
      { id: 'env', name: 'Box', snapshot: snapshot('env', 'live') }
    ])
    call.mockResolvedValue(psReply([{ worktreeId: 'w', hostId: 'local', status: 'working' }]))
    const { catalog: hostCatalog } = catalog(hosts)
    await hostCatalog.worktrees('runtime:env')

    state.environments = [{ id: 'env', name: 'Box', snapshot: snapshot('env', 'unreachable') }]
    const offline = await hostCatalog.worktrees('runtime:env')
    expect(call).toHaveBeenCalledTimes(1)
    expect(offline).toEqual({
      worktrees: [{ worktreeId: 'w', hostId: 'runtime:env', status: 'working' }]
    })

    state.environments = [{ id: 'env', name: 'Box', snapshot: snapshot('env', 'live') }]
    call.mockRejectedValueOnce(new Error('socket closed'))
    await expect(hostCatalog.worktrees('runtime:env')).resolves.toEqual(offline)
    expect(call).toHaveBeenCalledTimes(2)
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
    await expect(catalog(hosts).catalog.worktrees('runtime:env')).resolves.toEqual({
      worktrees: [{ worktreeId: 'kept', hostId: 'runtime:env' }]
    })
  })

  it('lists an update-needed server live, since the desktop itself can still reach it', async () => {
    const { hosts, call } = fakeHosts([
      { id: 'old', name: 'ThinkPad', snapshot: snapshot('old', 'live', false) }
    ])
    call.mockResolvedValue(psReply([{ worktreeId: 'w', hostId: 'local' }]))
    await expect(catalog(hosts).catalog.worktrees('runtime:old')).resolves.toEqual({
      worktrees: [{ worktreeId: 'w', hostId: 'runtime:old' }]
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

  it('never serves rows from before a re-pair mid-fetch, and the next poll fetches the new server afresh', async () => {
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
    const next = hostCatalog.worktrees('runtime:env')
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    expect(call).toHaveBeenLastCalledWith(expect.anything(), 'worktree.ps', expect.anything(), {
      expected: { pairingRevision: 2, runtimeId: 'runtime-a' }
    })
    await expect(next).resolves.toMatchObject({ worktrees: [{ worktreeId: 'new-server-row' }] })
    answerOldFetch(psReply([{ worktreeId: 'old-server-row', hostId: 'local' }]))
    await expect(rows).resolves.toEqual({
      worktrees: [{ worktreeId: 'new-server-row', hostId: 'runtime:env' }]
    })
    await expect(hostCatalog.worktrees('runtime:env')).resolves.toMatchObject({
      worktrees: [{ worktreeId: 'new-server-row' }]
    })
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
    state.environments = [{ ...removed[0]!, snapshot: snapshot('env', 'unreachable') }]
    await expect(hostCatalog.worktrees('runtime:env')).resolves.toEqual({ worktrees: null })
  })

  it('keeps the last rows for a server manually disconnected but still configured', async () => {
    const { hosts, call, state } = fakeHosts([
      { id: 'env', name: 'Box', snapshot: snapshot('env', 'live') }
    ])
    call.mockResolvedValue(psReply([{ worktreeId: 'w', hostId: 'local' }]))
    const { catalog: hostCatalog } = catalog(hosts)
    await hostCatalog.worktrees('runtime:env')
    state.environments = [
      {
        id: 'env',
        name: 'Box',
        snapshot: { ...snapshot('env', 'unreachable'), retired: true, verification: 'blocked' }
      }
    ]
    state.retire('env')
    await expect(hostCatalog.worktrees('runtime:env')).resolves.toEqual({
      worktrees: [{ worktreeId: 'w', hostId: 'runtime:env' }]
    })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('lists a server whose runtime id the desktop has not recorded yet', async () => {
    const { hosts, call } = fakeHosts([
      { id: 'env', name: 'Box', snapshot: snapshot('env', 'live'), runtimeId: null }
    ])
    call.mockResolvedValue(psReply([{ worktreeId: 'w', hostId: 'local' }]))
    await expect(catalog(hosts).catalog.worktrees('runtime:env')).resolves.toMatchObject({
      worktrees: [{ worktreeId: 'w' }]
    })
    expect(call).toHaveBeenCalledWith(expect.anything(), 'worktree.ps', expect.anything(), {
      expected: { pairingRevision: 1, runtimeId: null }
    })
  })

  it('answers with the last rows when the server never answers the fetch', async () => {
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
      await expect(rows).resolves.toEqual({
        worktrees: [{ worktreeId: 'w', hostId: 'runtime:env' }]
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
    const rows = { worktrees: [{ worktreeId: 'w', hostId: 'runtime:env' }] }
    await expect(Promise.all([first, second])).resolves.toEqual([rows, rows])
    expect(call).toHaveBeenCalledTimes(1)
  })
})

describe("mobile relay host catalog: the desktop sidebar's own view of server rows", () => {
  // Relayed phone creates record the relaying desktop as provenance.
  const creators = [
    { worktreeId: 'mine', creatorProvenance: { kind: 'paired-device', deviceId: 'desktop' } },
    { worktreeId: 'other', creatorProvenance: { kind: 'paired-device', deviceId: 'laptop' } },
    { worktreeId: 'server', creatorProvenance: { kind: 'host' } },
    { worktreeId: 'unknown' }
  ]

  function serverRows(desktop: Parameters<typeof catalog>[2], pairedDeviceId = 'desktop') {
    const { hosts, call } = fakeHosts([
      { id: 'env', name: 'Box', snapshot: snapshot('env', 'live'), pairedDeviceId }
    ])
    call.mockResolvedValue(psReply(creators))
    return catalog(hosts, new Map(), desktop).catalog.worktrees('runtime:env')
  }

  function marked(rows: Awaited<ReturnType<typeof serverRows>>, field: string): unknown[] {
    return (rows.worktrees ?? []).filter((row) => row[field] === true).map((row) => row.worktreeId)
  }

  it('marks rows someone else created, whatever the desktop filter says', async () => {
    const rows = await serverRows({})
    expect(marked(rows, 'desktopOtherClient')).toEqual(['other', 'server'])
    expect(rows.worktrees).toHaveLength(creators.length)
  })

  it('marks nothing on a server whose pairing the desktop cannot name', async () => {
    const { hosts, call } = fakeHosts([
      { id: 'env', name: 'Box', snapshot: snapshot('env', 'live') }
    ])
    call.mockResolvedValue(psReply(creators))
    const rows = await catalog(hosts, new Map()).catalog.worktrees('runtime:env')
    expect(marked(rows, 'desktopOtherClient')).toEqual([])
  })

  function browserTab(worktreeId: string): BrowserWorkspace {
    return {
      id: `browser-${worktreeId}`,
      worktreeId,
      url: 'about:blank',
      title: '',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: 0
    }
  }

  function tab(
    worktreeId: string,
    contentType: Tab['contentType'],
    agent?: Tab['agentSessionAgent']
  ): Tab {
    return {
      id: `${contentType}-${worktreeId}`,
      entityId: worktreeId,
      groupId: 'group',
      worktreeId,
      contentType,
      label: '',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 0,
      ...(agent ? { agentSessionAgent: agent } : {})
    }
  }

  it("counts the desktop's saved browser or chat tabs as the row's sidebar activity", async () => {
    const rows = await serverRows({
      sessions: {
        'runtime:env': {
          browserTabsByWorktree: { mine: [browserTab('mine')], other: [] },
          unifiedTabs: {
            'worktree:server': [tab('server', 'agent-session', 'claude')],
            unknown: [tab('unknown', 'terminal')]
          }
        },
        local: { browserTabsByWorktree: { other: [browserTab('other')] } }
      }
    })
    expect(marked(rows, 'hasHostSidebarActivity')).toEqual(['mine', 'server'])
  })
})
