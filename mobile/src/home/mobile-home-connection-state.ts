import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, HostCatalogEntry } from '../transport/types'

export type MobileHomeClientEntry = {
  hostId: string
  client: RpcClient
  state: ConnectionState
}

export function readMobileHomeReconnectAttempts(
  previous: Record<string, number>,
  clients: MobileHomeClientEntry[]
): Record<string, number> {
  const next = { ...previous }
  let changed = false
  for (const entry of clients) {
    const attempts = entry.client.getReconnectAttempt()
    if (next[entry.hostId] !== attempts) {
      next[entry.hostId] = attempts
      changed = true
    }
  }
  return changed ? next : previous
}

export function readMobileHomeLastConnected(
  previous: Record<string, number | null>,
  clients: MobileHomeClientEntry[]
): Record<string, number | null> {
  const next = { ...previous }
  let changed = false
  for (const entry of clients) {
    const connectedAt = entry.client.getLastConnectedAt()
    if (next[entry.hostId] !== connectedAt) {
      next[entry.hostId] = connectedAt
      changed = true
    }
  }
  return changed ? next : previous
}

export function reconcileMobileHomeHostStates(
  previous: Record<string, ConnectionState>,
  clients: MobileHomeClientEntry[],
  hostCatalog: HostCatalogEntry[]
): Record<string, ConnectionState> {
  const next = { ...previous }
  let changed = false
  const liveIds = new Set(clients.map((entry) => entry.hostId))
  for (const entry of clients) {
    if (next[entry.hostId] !== entry.state) {
      next[entry.hostId] = entry.state
      changed = true
    }
  }
  for (const host of hostCatalog) {
    if (liveIds.has(host.id)) {
      continue
    }
    const fallback = host.credentialStatus === 'missing' ? 'auth-failed' : 'disconnected'
    const previousState = next[host.id]
    const shouldTrack =
      host.credentialStatus !== 'ready' ||
      (previousState != null && previousState !== 'disconnected' && previousState !== 'auth-failed')
    if (shouldTrack && previousState !== fallback) {
      next[host.id] = fallback
      changed = true
    }
  }
  for (const id of Object.keys(next)) {
    if (!liveIds.has(id) && !hostCatalog.some((host) => host.id === id)) {
      delete next[id]
      changed = true
    }
  }
  return changed ? next : previous
}
