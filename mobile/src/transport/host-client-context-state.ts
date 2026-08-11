import type { RpcClient } from './rpc-client'
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

export function primeHostProfiles(cache: Map<string, HostProfile>, hosts: HostProfile[]): void {
  for (const host of hosts) {
    cache.set(host.id, host)
  }
}

export function clientActivePath(client: RpcClient | undefined): MobileConnectionPath {
  const logical = client as Partial<StableLogicalRpcClient> | undefined
  if (typeof logical?.getActivePath !== 'function') {
    return 'lan'
  }
  // Why: during migration the pending path is what the user is waiting on.
  return logical.getPendingPath?.() ?? logical.getActivePath()
}
