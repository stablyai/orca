import { useEffect, useMemo, useRef, useState } from 'react'
import { subscribeToDesktopNotifications } from '../notifications/mobile-notifications'
import { usePrimeHosts } from '../transport/host-client-hooks'
import { createHostConnectRefetchGate } from '../transport/host-connect-refetch-gate'
import { selectHomeAutoConnectHostIds } from '../transport/home-host-auto-connect'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, HostCatalogEntry, HostProfile } from '../transport/types'
import { useAllHostClients } from '../transport/use-all-host-clients'
import {
  fetchHomeHostWorktreeInfo,
  type HostWorktreeInfoSetter
} from '../worktree/home-host-worktree-fetch'
import { withoutHomeAgentStates } from '../worktree/home-worktree-info'
import {
  readMobileHomeLastConnected,
  readMobileHomeReconnectAttempts,
  reconcileMobileHomeHostStates
} from './mobile-home-connection-state'

// Same pace as the workspace list's poll; agent status notices can arrive many times a second.
const HOME_WORKTREE_REFRESH_MIN_INTERVAL_MS = 3000
const WORKTREE_CHANGE_EVENTS: ReadonlySet<string> = new Set([
  'sidebarInputsChanged',
  'worktreesChanged',
  'reposChanged'
])

function wireMobileHomeHostSubscriptions(
  entry: { hostId: string; client: RpcClient; state: ConnectionState },
  setWorktreeInfo: HostWorktreeInfoSetter,
  isHomeFocused: () => boolean
): () => void {
  let unsubscribeNotifications: (() => void) | null = null
  let unsubscribeClientEvents: (() => void) | null = null
  let lastRefreshAt = 0
  let trailingRefresh: ReturnType<typeof setTimeout> | null = null
  const refetchGate = createHostConnectRefetchGate()
  const refreshWorktrees = (): void => {
    lastRefreshAt = Date.now()
    void fetchHomeHostWorktreeInfo(entry.client, entry.hostId, setWorktreeInfo, () => false)
  }
  // Home stays mounted under other screens; focusing it again re-reads every desktop anyway.
  const refreshOnChange = (): void => {
    if (!isHomeFocused() || trailingRefresh) {
      return
    }
    const wait = lastRefreshAt + HOME_WORKTREE_REFRESH_MIN_INTERVAL_MS - Date.now()
    if (wait <= 0) {
      refreshWorktrees()
      return
    }
    trailingRefresh = setTimeout(() => {
      trailingRefresh = null
      if (isHomeFocused()) {
        refreshWorktrees()
      }
    }, wait)
  }
  const wireState = (state: ConnectionState): void => {
    const reconnected = refetchGate.observe(state)
    if (state === 'connected') {
      unsubscribeNotifications ??= subscribeToDesktopNotifications(entry.client, entry.hostId)
      unsubscribeClientEvents ??= entry.client.subscribe(
        'runtime.clientEvents.subscribe',
        null,
        (payload) => {
          if (
            payload &&
            typeof payload === 'object' &&
            'type' in payload &&
            typeof payload.type === 'string' &&
            WORKTREE_CHANGE_EVENTS.has(payload.type)
          ) {
            refreshOnChange()
          }
        }
      )
      if (reconnected) {
        refreshWorktrees()
      }
      return
    }
    unsubscribeNotifications?.()
    unsubscribeNotifications = null
    unsubscribeClientEvents?.()
    unsubscribeClientEvents = null
    // Agents keep moving while we're away; only the reconnect read may show their states again.
    setWorktreeInfo((previous) => {
      const current = previous[entry.hostId]
      const next = current && withoutHomeAgentStates(current)
      return next === current ? previous : { ...previous, [entry.hostId]: next }
    })
  }
  wireState(entry.state)
  const unsubscribeState = entry.client.onStateChange(wireState)
  return () => {
    unsubscribeState()
    unsubscribeNotifications?.()
    unsubscribeClientEvents?.()
    if (trailingRefresh) {
      clearTimeout(trailingRefresh)
    }
  }
}

export function useMobileHomeHostConnections(
  hosts: HostProfile[],
  hostCatalog: HostCatalogEntry[],
  setWorktreeInfo: HostWorktreeInfoSetter,
  isHomeFocused: () => boolean
) {
  const [hostStates, setHostStates] = useState<Record<string, ConnectionState>>({})
  const [hostAttempts, setHostAttempts] = useState<Record<string, number>>({})
  const [hostLastConnected, setHostLastConnected] = useState<Record<string, number | null>>({})
  const hostIds = useMemo(() => hosts.map((host) => host.id), [hosts])
  const autoConnectHostIds = useMemo(() => selectHomeAutoConnectHostIds(hosts), [hosts])
  const allClients = useAllHostClients(hostIds, {
    autoConnectHostIds,
    closeUnusedOnRelease: true
  })
  const primeHosts = usePrimeHosts()
  const subscriptionsRef = useRef(new Map<string, { client: RpcClient; cleanup: () => void }>())

  useEffect(() => {
    if (hosts.length > 0) {
      primeHosts(hosts)
    }
  }, [hosts, primeHosts])

  useEffect(() => {
    setHostAttempts((previous) => readMobileHomeReconnectAttempts(previous, allClients))
    setHostLastConnected((previous) => readMobileHomeLastConnected(previous, allClients))
    setHostStates((previous) => reconcileMobileHomeHostStates(previous, allClients, hostCatalog))
  }, [allClients, hostCatalog])

  useEffect(() => {
    const clientsByHostId = new Map(allClients.map((entry) => [entry.hostId, entry.client]))
    for (const [hostId, subscription] of subscriptionsRef.current) {
      if (clientsByHostId.get(hostId) !== subscription.client) {
        subscription.cleanup()
        subscriptionsRef.current.delete(hostId)
      }
    }
    for (const entry of allClients) {
      if (!subscriptionsRef.current.has(entry.hostId)) {
        subscriptionsRef.current.set(entry.hostId, {
          client: entry.client,
          cleanup: wireMobileHomeHostSubscriptions(entry, setWorktreeInfo, isHomeFocused)
        })
      }
    }
  }, [allClients, isHomeFocused, setWorktreeInfo])

  useEffect(() => {
    const subscriptions = subscriptionsRef.current
    return () => {
      for (const subscription of subscriptions.values()) {
        subscription.cleanup()
      }
      subscriptions.clear()
    }
  }, [])

  return {
    allClients,
    autoConnectHostIds,
    hostAttempts,
    hostLastConnected,
    hostStates
  }
}
