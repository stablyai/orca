import { connectionLogStore } from './connection-log-buffer'
import { loadHosts } from './host-store'
import { openHostLogicalClient } from './host-logical-client'
import type { HostClientOpenRegistry } from './host-client-open-registry'
import type { HostOpenRetryScheduler } from './host-open-retry-scheduler'
import type { RpcClient } from './rpc-client'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ConnectionState, HostProfile } from './types'

export type HostClientStoreEntry = {
  client: RpcClient
  state: ConnectionState
  refCount: number
  unsubState: () => void
  unsubConnectionPath: () => void
}

type HostEntryOpenerState = {
  store: Map<string, HostClientStoreEntry>
  pendingOpens: HostClientOpenRegistry
  pendingAcquisitions: Map<string, number>
  primedHosts: Map<string, HostProfile>
  retryScheduler: HostOpenRetryScheduler
  notifyHostState: (hostId: string, state: ConnectionState) => void
  notifyAllHosts: () => void
}

type HostOpenFailureCategory = 'catalog-unavailable' | 'host-not-found' | 'client-construction'

export async function openHostClientEntry(
  state: HostEntryOpenerState,
  hostId: string,
  allowUnowned = false
): Promise<HostClientStoreEntry | null> {
  const existing = state.pendingOpens.getActivePromise(hostId)
  if (existing) {
    await existing
    return state.store.get(hostId) ?? null
  }
  let resolve: () => void = () => {}
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  const ticket = state.pendingOpens.register(hostId, promise)
  let settled = false
  const settle = () => {
    if (settled) {
      return
    }
    settled = true
    state.pendingOpens.deleteIfCurrent(hostId, ticket)
    resolve()
  }
  const isCurrent = () => state.pendingOpens.isCurrent(hostId, ticket)
  const isWanted = () => allowUnowned || (state.pendingAcquisitions.get(hostId) ?? 0) > 0
  const failCurrentOpen = (category: HostOpenFailureCategory) => {
    if (!isCurrent()) {
      return
    }
    settle()
    state.notifyHostState(hostId, 'disconnected')
    state.notifyAllHosts()
    const retry = state.retryScheduler.recordFailure(hostId, ticket.generation)
    connectionLogStore.append(hostId, {
      id: `host-open-${ticket.generation}-${Date.now()}`,
      ts: Date.now(),
      level: 'error',
      message: 'Host client open failed',
      detail: `${category}; retry ${retry.nextDelayMs}ms (failure ${retry.failureCount})`
    })
  }
  state.notifyHostState(hostId, 'connecting')

  try {
    let host = state.primedHosts.get(hostId)
    if (!host) {
      try {
        const hosts = await loadHosts()
        host = hosts.find((candidate) => candidate.id === hostId)
      } catch {
        failCurrentOpen('catalog-unavailable')
        return null
      }
      if (!host) {
        failCurrentOpen('host-not-found')
        return null
      }
    }
    if (!isCurrent() || !isWanted()) {
      return null
    }
    const published = state.store.get(hostId)
    if (published) {
      settle()
      state.retryScheduler.recordSuccess(hostId)
      return published
    }

    let client: RpcClient
    try {
      client = openHostLogicalClient(host, (entry) => connectionLogStore.append(hostId, entry))
    } catch {
      failCurrentOpen('client-construction')
      return null
    }
    if (!isCurrent() || !isWanted() || state.store.has(hostId)) {
      client.close()
      return state.store.get(hostId) ?? null
    }
    const unsubState = client.onStateChange((next) => {
      const current = state.store.get(hostId)
      if (!current) {
        return
      }
      current.state = next
      state.notifyHostState(hostId, next)
    })
    const logical = client as Partial<StableLogicalRpcClient>
    const unsubConnectionPath =
      logical.onConnectionPathChange?.(() => {
        const current = state.store.get(hostId)
        if (current) {
          state.notifyHostState(hostId, current.state)
        }
      }) ?? (() => {})
    const entry: HostClientStoreEntry = {
      client,
      state: client.getState(),
      refCount: state.pendingAcquisitions.get(hostId) ?? 0,
      unsubState,
      unsubConnectionPath
    }
    state.pendingAcquisitions.delete(hostId)
    state.store.set(hostId, entry)
    settle()
    const priorFailureCount = state.retryScheduler.recordSuccess(hostId)
    if (priorFailureCount > 0) {
      connectionLogStore.append(hostId, {
        id: `host-open-recovered-${ticket.generation}-${Date.now()}`,
        ts: Date.now(),
        level: 'success',
        message: 'Host client recovered',
        detail: `after ${priorFailureCount} failed open${priorFailureCount === 1 ? '' : 's'}`
      })
    }
    state.notifyHostState(hostId, entry.state)
    state.notifyAllHosts()
    return entry
  } finally {
    settle()
  }
}
