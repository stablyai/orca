import { useEffect, useMemo, useRef, useState } from 'react'
import { decodeAccountsSnapshot } from '../components/AccountUsage'
import { subscribeToDesktopNotifications } from '../notifications/mobile-notifications'
import { usePrimeHosts } from '../transport/client-context'
import { createHostConnectRefetchGate } from '../transport/host-connect-refetch-gate'
import { selectHomeAutoConnectHostIds } from '../transport/home-host-auto-connect'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, HostCatalogEntry, HostProfile } from '../transport/types'
import { useAllHostClients } from '../transport/use-all-host-clients'
import {
  fetchHomeHostWorktreeInfo,
  type HostWorktreeInfoSetter
} from '../worktree/home-host-worktree-fetch'
import {
  readMobileHomeLastConnected,
  readMobileHomeReconnectAttempts,
  reconcileMobileHomeHostStates
} from './mobile-home-connection-state'
import {
  fetchMobileHomeStats,
  fetchMobileHomeTaskProviders,
  type HomeAccountsSetter,
  type HomeStatsSetter,
  type HomeTaskProvidersSetter
} from './mobile-home-host-requests'

type Setters = {
  setStats: HomeStatsSetter
  setWorktreeInfo: HostWorktreeInfoSetter
  setAccounts: HomeAccountsSetter
  setTaskProviders: HomeTaskProvidersSetter
}

function wireMobileHomeHostSubscriptions(
  entry: { hostId: string; client: RpcClient; state: ConnectionState },
  setters: Setters
): () => void {
  let unsubscribeNotifications: (() => void) | null = null
  let unsubscribeAccounts: (() => void) | null = null
  const refetchGate = createHostConnectRefetchGate()
  const wireState = (state: ConnectionState): void => {
    const reconnected = refetchGate.observe(state)
    if (state === 'connected') {
      unsubscribeNotifications ??= subscribeToDesktopNotifications(entry.client, entry.hostId)
      unsubscribeAccounts ??= entry.client.subscribe('accounts.subscribe', null, (payload) => {
        if (!payload || typeof payload !== 'object') {
          return
        }
        const event = payload as { type?: string; snapshot?: unknown }
        if (event.type !== 'ready' && event.type !== 'snapshot') {
          return
        }
        try {
          const snapshot = decodeAccountsSnapshot(event.snapshot)
          setters.setAccounts((previous) => ({ ...previous, [entry.hostId]: snapshot }))
        } catch {
          // Keep the last proven snapshot when a mixed-version host publishes malformed data.
        }
      })
      if (reconnected) {
        fetchMobileHomeStats(entry.client, entry.hostId, setters.setStats, () => false)
        void fetchHomeHostWorktreeInfo(
          entry.client,
          entry.hostId,
          setters.setWorktreeInfo,
          () => false
        )
        fetchMobileHomeTaskProviders(
          entry.client,
          entry.hostId,
          setters.setTaskProviders,
          () => false
        )
      }
      return
    }
    unsubscribeNotifications?.()
    unsubscribeNotifications = null
    unsubscribeAccounts?.()
    unsubscribeAccounts = null
  }
  wireState(entry.state)
  const unsubscribeState = entry.client.onStateChange(wireState)
  return () => {
    unsubscribeState()
    unsubscribeNotifications?.()
    unsubscribeAccounts?.()
  }
}

export function useMobileHomeHostConnections(
  hosts: HostProfile[],
  hostCatalog: HostCatalogEntry[],
  setters: Setters
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
  const { setAccounts, setStats, setTaskProviders, setWorktreeInfo } = setters

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
    const activeSetters = { setAccounts, setStats, setTaskProviders, setWorktreeInfo }
    for (const entry of allClients) {
      if (!subscriptionsRef.current.has(entry.hostId)) {
        subscriptionsRef.current.set(entry.hostId, {
          client: entry.client,
          cleanup: wireMobileHomeHostSubscriptions(entry, activeSetters)
        })
      }
    }
  }, [allClients, setAccounts, setStats, setTaskProviders, setWorktreeInfo])

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
