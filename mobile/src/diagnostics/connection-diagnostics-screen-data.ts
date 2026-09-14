import type { ConnectionLogStore } from '../transport/connection-log-buffer'
import type { ConnectionLogEntry, HostProfile } from '../transport/types'
import type { RpcClientContextValue } from '../transport/rpc-client-context-contract'

export type DiagnosticsHostSelection = {
  hostId: string
  requestedHostId: string | undefined
  routeKey?: object
}

export type DiagnosticsSubmissionState = 'sending' | 'sent' | 'failed'
export type DiagnosticsSubmissionStates = Readonly<Record<string, DiagnosticsSubmissionState>>

export function selectDiagnosticsHostId(
  hosts: readonly HostProfile[],
  requestedHostId: string | undefined,
  previousHostId: string | null
): string | null {
  if (requestedHostId && hosts.some((host) => host.id === requestedHostId)) {
    return requestedHostId
  }
  if (previousHostId && hosts.some((host) => host.id === previousHostId)) {
    return previousHostId
  }
  return hosts[0]?.id ?? null
}

export function resolveDiagnosticsHostId(
  hosts: readonly HostProfile[],
  requestedHostId: string | undefined,
  manualSelection: DiagnosticsHostSelection | null,
  routeKey?: object
): string | null {
  const selected = manualSelection
  if (selected && selected.requestedHostId === requestedHostId && selected.routeKey === routeKey) {
    const manualHostId = selected.hostId
    if (hosts.some((host) => host.id === manualHostId)) {
      return manualHostId
    }
  }
  return selectDiagnosticsHostId(hosts, requestedHostId, null)
}

export function getDiagnosticsSubmissionState(
  states: DiagnosticsSubmissionStates,
  key: string | null
): DiagnosticsSubmissionState | 'idle' {
  return key ? (states[key] ?? 'idle') : 'idle'
}

export function updateDiagnosticsSubmissionState(
  states: DiagnosticsSubmissionStates,
  key: string,
  state: DiagnosticsSubmissionState | null
): DiagnosticsSubmissionStates {
  const next = { ...states }
  if (state) {
    next[key] = state
  } else {
    delete next[key]
  }
  return next
}

export async function readHydratedConnectionLog(
  store: Pick<ConnectionLogStore, 'hydrate' | 'get'>,
  hostId: string
): Promise<readonly ConnectionLogEntry[]> {
  try {
    await store.hydrate(hostId)
  } catch {
    await store.hydrate(hostId).catch(() => {})
  }
  return store.get(hostId)
}

export async function readConnectionDiagnosticsSnapshot(
  context: Pick<
    RpcClientContextValue,
    'getState' | 'getReconnectAttempt' | 'getLastConnectedAt' | 'getActivePath' | 'getPendingPath'
  >,
  store: Pick<ConnectionLogStore, 'hydrate' | 'get'>,
  hostId: string
) {
  const entries = await readHydratedConnectionLog(store, hostId)
  return {
    state: context.getState(hostId),
    reconnectAttempts: context.getReconnectAttempt(hostId),
    lastConnectedAt: context.getLastConnectedAt(hostId),
    activePath: context.getActivePath(hostId),
    pendingPath: context.getPendingPath(hostId),
    entries
  }
}
