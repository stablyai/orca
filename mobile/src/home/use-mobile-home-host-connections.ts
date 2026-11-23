import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  accountsSnapshotKey,
  subscribeAccountsSnapshots
} from '../accounts/accounts-snapshot-stream'
import { subscribeToDesktopNotifications } from '../notifications/mobile-notifications'
import { retainHostConnectionInvalidation } from '../query/host-connection-invalidation'
import { retainHostEventRouter } from '../query/host-event-router'
import { keepNativeHostQueries } from '../query/native-query-persistence'
import { usePrimeHosts } from '../transport/connection/host-client-hooks'
import { selectHomeAutoConnectHostIds } from '../transport/hosts/home-host-auto-connect'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../transport/connection/connection-state'
import type { HostCatalogEntry, HostProfile } from '../host-catalog/host-profile'
import { useAllHostClients } from '../transport/connection/use-all-host-clients'
import {
  readMobileHomeLastConnected,
  readMobileHomeReconnectAttempts,
  reconcileMobileHomeHostStates
} from './mobile-home-connection-state'

// Home's per-desktop reads (counts, stats) are queries; this wires what a connection carries besides them.
function wireMobileHomeHostSubscriptions(
  entry: { hostId: string; client: RpcClient },
  queryClient: QueryClient
): () => void {
  const { hostId, client } = entry
  keepNativeHostQueries(queryClient, hostId)
  // Reads Home's queries again on each reconnect, and on the desktop's change notices.
  const stopInvalidation = retainHostConnectionInvalidation(queryClient, hostId, client)
  const router = retainHostEventRouter(queryClient, hostId, client)
  let unsubscribeNotifications: (() => void) | null = null
  let unsubscribeAccounts: (() => void) | null = null
  const wireState = (state: ConnectionState): void => {
    if (state === 'connected') {
      unsubscribeNotifications ??= subscribeToDesktopNotifications(client, hostId)
      // One stream per connection: each subscribe makes the desktop check usage, so focus must not resubscribe.
      unsubscribeAccounts ??= subscribeAccountsSnapshots(client, {
        onSnapshot: (snapshot) => queryClient.setQueryData(accountsSnapshotKey(hostId), snapshot),
        onInvalidSnapshot: () => queryClient.setQueryData(accountsSnapshotKey(hostId), null),
        onStreamError: () => {}
      })
      return
    }
    unsubscribeNotifications?.()
    unsubscribeNotifications = null
    unsubscribeAccounts?.()
    unsubscribeAccounts = null
  }
  // The live state: the client may have connected since the render that listed it.
  wireState(client.getState())
  const unsubscribeState = client.onStateChange(wireState)
  return () => {
    unsubscribeState()
    unsubscribeNotifications?.()
    unsubscribeAccounts?.()
    router.release()
    stopInvalidation()
  }
}

export function useMobileHomeHostConnections(
  hosts: HostProfile[],
  hostCatalog: HostCatalogEntry[]
) {
  const queryClient = useQueryClient()
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
          cleanup: wireMobileHomeHostSubscriptions(entry, queryClient)
        })
      }
    }
  }, [allClients, queryClient])

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
