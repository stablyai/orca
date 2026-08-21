import type { RpcClient } from './rpc-client'
import type { HostClientOpenRegistry } from './host-client-open-registry'
import type { HostClientStoreEntry } from './host-entry-opener'
import type { MobileConnectionPath, StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ConnectionState, HostProfile } from './types'

export type CloseEntryOptions = {
  forgetPrimedHost: boolean
  preserveAcquisitions: boolean
}

export function notifyHostStateListeners(
  listeners: Map<string, Set<(state: ConnectionState) => void>>,
  hostId: string,
  state: ConnectionState
): void {
  for (const listener of listeners.get(hostId) ?? []) {
    listener(state)
  }
}

export function notifyAllHostListeners(listeners: Set<() => void>): void {
  for (const listener of listeners) {
    listener()
  }
}

export function subscribeHostStateListener(
  listeners: Map<string, Set<(state: ConnectionState) => void>>,
  hostId: string,
  listener: (state: ConnectionState) => void
): () => void {
  let hostListeners = listeners.get(hostId)
  if (!hostListeners) {
    hostListeners = new Set()
    listeners.set(hostId, hostListeners)
  }
  hostListeners.add(listener)
  return () => {
    hostListeners.delete(listener)
    if (hostListeners.size === 0) {
      listeners.delete(hostId)
    }
  }
}

export function subscribeAllHostListener(
  listeners: Set<() => void>,
  listener: () => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function listHostClients(
  entries: ReadonlyMap<string, { client: RpcClient }>
): { hostId: string; client: RpcClient }[] {
  return [...entries].map(([hostId, entry]) => ({ hostId, client: entry.client }))
}

export function primeHostProfiles(cache: Map<string, HostProfile>, hosts: HostProfile[]): void {
  for (const host of hosts) {
    cache.set(host.id, host)
  }
}

export function createHostClientSelectors(
  entries: ReadonlyMap<string, HostClientStoreEntry>,
  pendingOpens: HostClientOpenRegistry
) {
  const getKnownState = (hostId: string): ConnectionState | null => {
    const entry = entries.get(hostId)
    if (entry) {
      return entry.state
    }
    // Why: the Keychain pass predates the store entry; this window is connecting.
    return pendingOpens.getActivePromise(hostId) ? 'connecting' : null
  }
  return {
    getKnownState,
    getState: (hostId: string): ConnectionState => getKnownState(hostId) ?? 'disconnected',
    getReconnectAttempt: (hostId: string): number =>
      entries.get(hostId)?.client.getReconnectAttempt() ?? 0,
    getLastConnectedAt: (hostId: string): number | null =>
      entries.get(hostId)?.client.getLastConnectedAt() ?? null,
    getActivePath: (hostId: string): MobileConnectionPath =>
      clientActivePath(entries.get(hostId)?.client),
    getPendingPath: (hostId: string): MobileConnectionPath | null =>
      clientPendingPath(entries.get(hostId)?.client),
    isPairingRejected: (hostId: string): boolean =>
      clientPairingRejected(entries.get(hostId)?.client)
  }
}

export function clientPairingRejected(client: RpcClient | undefined): boolean {
  const logical = client as Partial<StableLogicalRpcClient> | undefined
  return logical?.isPairingRejected?.() ?? false
}

export function clientActivePath(client: RpcClient | undefined): MobileConnectionPath {
  const logical = client as Partial<StableLogicalRpcClient> | undefined
  if (typeof logical?.getActivePath !== 'function') {
    return 'lan'
  }
  // Why: during migration the pending path is what the user is waiting on.
  return logical.getPendingPath?.() ?? logical.getActivePath()
}

export function clientPendingPath(client: RpcClient | undefined): MobileConnectionPath | null {
  const logical = client as Partial<StableLogicalRpcClient> | undefined
  return logical?.getPendingPath?.() ?? null
}
