// Run the catalog contract against per-request fetching instead of main-owned live rows.
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
import { OnDemandServerWorktreeRows } from './on-demand-server-worktree-rows'

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
    pairedDeviceId?: string
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
      environments: state.environments.map(
        ({ id, name, orcadDeployment, runtimeId, pairedDeviceId }) => ({
          id,
          name,
          orcadDeployment,
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
    call,
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
  return {
    catalog: new MobileRelayHostCatalog({
      hosts,
      serverRows: new OnDemandServerWorktreeRows(hosts),
      hostLabelOverrides: () => labels,
      getWorkspaceSession: (hostId) => {
        const session = desktop.sessions?.[hostId]
        return session ? { ...getDefaultWorkspaceSession(), ...session } : null
      }
    })
  }
}

describe('mobile relay host catalog, fetching on demand', () => {
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
    state.environments = [{ ...removed[0]!, snapshot: snapshot('env', 'unreachable') }]
    await expect(hostCatalog.worktrees('runtime:env')).resolves.toEqual({ worktrees: null })
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
