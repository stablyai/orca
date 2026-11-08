import { useEffect, useMemo, useRef, useState } from 'react'
import { subscribeAccountsSnapshots } from '../accounts/accounts-snapshot-stream'
import type { AccountsSnapshot } from '../components/AccountUsage'
import { subscribeToDesktopNotifications } from '../notifications/mobile-notifications'
import { usePrimeHosts } from '../transport/connection/host-client-hooks'
import { createHostConnectRefetchGate } from '../transport/hosts/host-connect-refetch-gate'
import { selectHomeAutoConnectHostIds } from '../transport/hosts/home-host-auto-connect'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { subscribeSharedClientEvents } from '../transport/connection/shared-client-events'
import type { ConnectionState } from '../transport/connection/connection-state'
import type { HostCatalogEntry, HostProfile } from '../transport/hosts/host-profile'
import { useAllHostClients } from '../transport/connection/use-all-host-clients'
import {
  fetchHomeHostWorktreeInfo,
  type HostWorktreeInfoSetter
} from '../worktree/home-host-worktree-fetch'
import { withLastSeenHomeAgents } from '../worktree/home-worktree-info'
import { fetchHomeHostStats, type HomeStatsSetter } from '../stats/home-stats-summary-read'
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
  'reposChanged',
  // The desktop Agents list changed; worktree.ps carries its verdicts.
  'agentListChanged',
  // Agent status changes on hosts without the sidebar feed (worktree.rows-changed-event.v1).
  'worktreeRowsChanged'
])

export type HomeAccountsSetter = (
  updater: (previous: Record<string, AccountsSnapshot>) => Record<string, AccountsSnapshot>
) => void

export type MobileHomeHostSetters = {
  setWorktreeInfo: HostWorktreeInfoSetter
  setStats: HomeStatsSetter
  setAccounts: HomeAccountsSetter
}

function wireMobileHomeHostSubscriptions(
  entry: { hostId: string; client: RpcClient; state: ConnectionState },
  setters: MobileHomeHostSetters,
  isHomeFocused: () => boolean
): () => void {
  const { setWorktreeInfo, setStats, setAccounts } = setters
  let unsubscribeNotifications: (() => void) | null = null
  let unsubscribeClientEvents: (() => void) | null = null
  let unsubscribeAccounts: (() => void) | null = null
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
      unsubscribeClientEvents ??= subscribeSharedClientEvents(entry.client, (event) => {
        // A replayed ready follows a reopened stream or path switch, which missed notices.
        if (WORKTREE_CHANGE_EVENTS.has(event.type) || 'replayed' in event) {
          refreshOnChange()
        }
      })
      // One stream per connection: each subscribe makes the desktop check usage, so focus must not resubscribe.
      unsubscribeAccounts ??= subscribeAccountsSnapshots(entry.client, {
        onSnapshot: (snapshot) =>
          setAccounts((previous) => ({ ...previous, [entry.hostId]: snapshot })),
        onInvalidSnapshot: () => setAccounts((previous) => withoutHost(previous, entry.hostId)),
        onStreamError: () => {}
      })
      if (reconnected) {
        refreshWorktrees()
        fetchHomeHostStats(entry.client, entry.hostId, setStats, () => false)
      }
      return
    }
    unsubscribeNotifications?.()
    unsubscribeNotifications = null
    unsubscribeClientEvents?.()
    unsubscribeClientEvents = null
    unsubscribeAccounts?.()
    unsubscribeAccounts = null
    // Usage is live; a disconnected desktop's last numbers would read as current.
    setAccounts((previous) => withoutHost(previous, entry.hostId))
    // Agents keep moving while we're away; only the reconnect read may show their states again.
    setWorktreeInfo((previous) => {
      const current = previous[entry.hostId]
      const next = current && withLastSeenHomeAgents(current)
      return next === current ? previous : { ...previous, [entry.hostId]: next }
    })
  }
  wireState(entry.state)
  const unsubscribeState = entry.client.onStateChange(wireState)
  return () => {
    unsubscribeState()
    unsubscribeNotifications?.()
    unsubscribeClientEvents?.()
    unsubscribeAccounts?.()
    if (trailingRefresh) {
      clearTimeout(trailingRefresh)
    }
  }
}

function withoutHost<T>(byHost: Record<string, T>, hostId: string): Record<string, T> {
  if (!(hostId in byHost)) {
    return byHost
  }
  const { [hostId]: _removed, ...rest } = byHost
  return rest
}

export function useMobileHomeHostConnections(
  hosts: HostProfile[],
  hostCatalog: HostCatalogEntry[],
  setters: MobileHomeHostSetters,
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

  // Reconcile during render: allClients rebuilds per host tick, and an effect would commit Home twice.
  const [reconciledFrom, setReconciledFrom] = useState<{
    allClients: typeof allClients
    hostCatalog: HostCatalogEntry[]
  } | null>(null)
  if (reconciledFrom?.allClients !== allClients || reconciledFrom.hostCatalog !== hostCatalog) {
    setReconciledFrom({ allClients, hostCatalog })
    setHostAttempts((previous) => readMobileHomeReconnectAttempts(previous, allClients))
    setHostLastConnected((previous) => readMobileHomeLastConnected(previous, allClients))
    setHostStates((previous) => reconcileMobileHomeHostStates(previous, allClients, hostCatalog))
  }

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
          cleanup: wireMobileHomeHostSubscriptions(entry, setters, isHomeFocused)
        })
      }
    }
  }, [allClients, isHomeFocused, setters])

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
