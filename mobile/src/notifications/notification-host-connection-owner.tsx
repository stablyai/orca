import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AppState } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import { rpcClientIdentity } from '../transport/rpc-client-identity'
import { subscribeHostCollectionChanges } from '../transport/host-collection-changes'
import { selectConnectableHostProfiles } from '../transport/host-catalog-selection'
import { loadHostCatalog } from '../transport/host-store'
import { usePrimeHosts } from '../transport/client-context'
import { connectionLogStore } from '../transport/connection-log-buffer'
import type { ConnectionState, HostProfile } from '../transport/types'
import { useAllHostClients } from '../transport/use-all-host-clients'
import { subscribeToDesktopNotifications } from './mobile-notifications'
import { retireHostNotificationState } from './notification-reconnect-catchup'

const HOST_REFRESH_RETRY_DELAYS_MS = [250, 1_000, 5_000, 15_000] as const

function subscribeToHostNotificationLifecycle(client: RpcClient, hostId: string): () => void {
  let unsubscribeNotifications: (() => void) | null = null
  const wire = (state: ConnectionState) => {
    if (state === 'connected' && !unsubscribeNotifications) {
      unsubscribeNotifications = subscribeToDesktopNotifications(client, hostId)
    } else if (state !== 'connected') {
      unsubscribeNotifications?.()
      unsubscribeNotifications = null
    }
  }
  const unsubscribeState = client.onStateChange(wire)
  wire(client.getState())
  return () => {
    unsubscribeState()
    unsubscribeNotifications?.()
  }
}

function NotificationHostClientOwner({ client, hostId }: { client: RpcClient; hostId: string }) {
  useEffect(() => subscribeToHostNotificationLifecycle(client, hostId), [client, hostId])
  return null
}

function subscribeNotificationHostCatalog(
  updateHosts: (hosts: HostProfile[]) => void,
  retireHosts: (hostIds: readonly string[]) => void
): () => void {
  let disposed = false
  let loadRevision = 0
  let retryIndex = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let profilesByHostId = new Map<string, HostProfile>()
  const scheduleRetry = () => {
    if (retryTimer || disposed) {
      return
    }
    const delay =
      HOST_REFRESH_RETRY_DELAYS_MS[Math.min(retryIndex, HOST_REFRESH_RETRY_DELAYS_MS.length - 1)]
    retryIndex += 1
    retryTimer = setTimeout(() => {
      retryTimer = null
      refreshHosts()
    }, delay)
  }
  const refreshHosts = (resetRetry = false) => {
    if (resetRetry) {
      retryIndex = 0
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
    }
    const revision = ++loadRevision
    // Why: rejection handler as the second `then` arg so only catalog loads retry, not update errors.
    void loadHostCatalog().then((catalog) => {
      if (!disposed && revision === loadRevision) {
        const nextHosts = selectConnectableHostProfiles(catalog)
        const readyHostIds = new Set(nextHosts.map(({ id }) => id))
        for (const entry of catalog) {
          if (entry.credentialStatus === 'temporarily-unavailable') {
            const retained = profilesByHostId.get(entry.id)
            if (retained && !readyHostIds.has(entry.id)) {
              nextHosts.push(retained)
            }
          }
        }
        profilesByHostId = new Map(nextHosts.map((host) => [host.id, host]))
        updateHosts(nextHosts)
        if (
          catalog.some(({ credentialStatus }) => credentialStatus === 'temporarily-unavailable')
        ) {
          scheduleRetry()
        } else {
          retryIndex = 0
        }
      }
    }, scheduleRetry)
  }
  const unsubscribeHosts = subscribeHostCollectionChanges(({ retiredHostIds }) => {
    if (retiredHostIds.length > 0) {
      for (const hostId of retiredHostIds) {
        profilesByHostId.delete(hostId)
      }
      retireHosts(retiredHostIds)
    }
    refreshHosts(true)
  })
  const appStateSubscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      refreshHosts(true)
    }
  })
  refreshHosts()
  return () => {
    disposed = true
    if (retryTimer) {
      clearTimeout(retryTimer)
    }
    unsubscribeHosts()
    appStateSubscription.remove()
  }
}

export function NotificationHostConnectionOwner() {
  const [hosts, setHosts] = useState<HostProfile[]>([])
  const [retiringHostIds, setRetiringHostIds] = useState<string[]>([])
  const retirementStartedRef = useRef(new Set<string>())
  const primeHosts = usePrimeHosts()

  useEffect(
    () =>
      subscribeNotificationHostCatalog(setHosts, (retiredHostIds) => {
        const retired = new Set(retiredHostIds)
        setHosts((current) => current.filter(({ id }) => !retired.has(id)))
        setRetiringHostIds((current) => [...new Set([...current, ...retiredHostIds])])
      }),
    []
  )

  const retiringHostIdSet = useMemo(() => new Set(retiringHostIds), [retiringHostIds])
  const activeHosts = useMemo(
    () => hosts.filter(({ id }) => !retiringHostIdSet.has(id)),
    [hosts, retiringHostIdSet]
  )

  useLayoutEffect(() => {
    primeHosts(activeHosts)
  }, [activeHosts, primeHosts])

  const hostIds = useMemo(() => activeHosts.map(({ id }) => id), [activeHosts])
  const clients = useAllHostClients(hostIds, {
    closeUnusedOnRelease: true,
    observeConnectionState: false
  })

  useEffect(() => {
    for (const hostId of retiringHostIds) {
      if (retirementStartedRef.current.has(hostId)) {
        continue
      }
      retirementStartedRef.current.add(hostId)
      connectionLogStore.clear(hostId)
      // Why unguarded: React 19 makes a post-unmount setState a no-op, and skipping it would
      // strand hostId in retiringHostIds, which activeHosts filters out with no way back.
      void retireHostNotificationState(hostId).finally(() => {
        retirementStartedRef.current.delete(hostId)
        setRetiringHostIds((current) => current.filter((id) => id !== hostId))
      })
    }
  }, [retiringHostIds])

  return (
    <>
      {clients.map(({ client, hostId }) => (
        <NotificationHostClientOwner
          key={`${hostId}:${rpcClientIdentity(client)}`}
          client={client}
          hostId={hostId}
        />
      ))}
    </>
  )
}
