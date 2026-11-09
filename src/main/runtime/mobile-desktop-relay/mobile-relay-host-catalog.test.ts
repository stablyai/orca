import { describe, expect, it, vi } from 'vitest'
import { DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY } from '../../../shared/delegated-mobile-device-contract'
import { RUNTIME_PROTOCOL_VERSION } from '../../../shared/protocol-version'
import {
  runtimeEnvironmentStatusFromSnapshot,
  type RuntimeHostStatusSnapshot
} from '../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../shared/runtime-session-contracts'
import type { SshConnectionState } from '../../../shared/ssh-types'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'

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
    statusChanged: () => {},
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
    onStatusChanged: (listener) => {
      state.statusChanged = listener
      return () => {}
    },
    watchChanges: () => ({ close: () => {}, current: () => true })
  }
  return { hosts, call, state }
}

function catalog(
  hosts: MobileDesktopRelayHosts,
  labels = new Map(),
  desktop: {
    sessions?: Record<string, Partial<WorkspaceSessionState>>
    recipeEnvironmentsFor?: (
      hostId: string
    ) => ReadonlyMap<string, { name: string; destroys: boolean }>
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
      },
      ...(desktop.recipeEnvironmentsFor
        ? { recipeEnvironmentsFor: desktop.recipeEnvironmentsFor }
        : {})
    })
  }
}

describe('mobile relay host catalog', () => {
  it('names the recipe environment on rows whose VM this desktop created, and only those', async () => {
    const { hosts, call } = fakeHosts([
      { id: 'env', name: 'Box', snapshot: snapshot('env', 'live') }
    ])
    call.mockResolvedValueOnce(
      psReply([
        { worktreeId: 'recipe-row', hostId: 'local' },
        { worktreeId: 'plain-row', hostId: 'local' }
      ])
    )
    const lookups: string[] = []
    const { catalog: hostCatalog } = catalog(hosts, new Map(), {
      recipeEnvironmentsFor: (hostId) => {
        lookups.push(hostId)
        return new Map([['recipe-row', { name: 'task', destroys: true }]])
      }
    })
    await expect(hostCatalog.worktrees('runtime:env')).resolves.toEqual({
      worktrees: [
        {
          worktreeId: 'recipe-row',
          hostId: 'runtime:env',
          recipeEnvironment: { name: 'task', destroys: true }
        },
        { worktreeId: 'plain-row', hostId: 'runtime:env' }
      ]
    })
    // One store read per poll, not one per row.
    expect(lookups).toEqual(['runtime:env'])
  })

  it("drops a server's own recipe-environment claim and survives an unreadable VM store", async () => {
    const { hosts, call } = fakeHosts([
      { id: 'env', name: 'Box', snapshot: snapshot('env', 'live') }
    ])
    call.mockResolvedValue(
      psReply([
        { worktreeId: 'claimed', hostId: 'local', recipeEnvironment: { name: 'x', destroys: true } }
      ])
    )
    const { catalog: hostCatalog } = catalog(hosts, new Map(), {
      recipeEnvironmentsFor: () => {
        throw new Error('store unreadable')
      }
    })
    await expect(hostCatalog.worktrees('runtime:env')).resolves.toEqual({
      worktrees: [{ worktreeId: 'claimed', hostId: 'runtime:env' }]
    })
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

  it('tells phones when a status change alters the host list, and not when it leaves it as is', async () => {
    const { hosts, state } = fakeHosts([
      { id: 'env', name: 'Box', snapshot: snapshot('env', 'live') }
    ])
    const { catalog: hostCatalog } = catalog(hosts)
    const changed = vi.fn()
    hostCatalog.publishListChanges({ onClientEvent: () => () => {}, changed })
    expect(hostCatalog.list().hosts).toMatchObject([{ hostId: 'runtime:env', relay: 'ready' }])

    state.statusChanged()
    await Promise.resolve()
    expect(changed).not.toHaveBeenCalled()

    state.environments = [{ ...state.environments[0]!, snapshot: snapshot('env', 'unreachable') }]
    state.statusChanged()
    await Promise.resolve()
    expect(changed).toHaveBeenCalledTimes(1)
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
})
