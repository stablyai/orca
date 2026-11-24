import { useEffect, useState } from 'react'
import { useRouter } from 'expo-router'
import { nativeLiveActivities, type LiveActivityRoute } from './native-live-activities'
import { usePendingLiveActivityLink } from './pending-live-activity-link'
import { loadHostCatalog } from '../host-catalog/host-store'
import { getNotificationNavigationTarget } from '../notifications/navigation/notification-routing'
import { useOpenNotificationRoute } from '../notifications/navigation/use-open-notification-route'
import { useLiveActivityHosts } from './use-live-activity-hosts'
import { useHostClient } from '../transport/connection/host-client-hooks'
import { resolveLiveActivitySession } from './live-activity-operations'

export function LiveActivityNavigation() {
  useLiveActivityLinks()
  return null
}

export function useLiveActivityLinks(): void {
  useLiveActivityHosts()
  const pending = usePendingLiveActivityLink()
  const open = useOpenNotificationRoute()
  const router = useRouter()
  const [destination, setDestination] = useState<{
    route: LiveActivityRoute & { activityId: string }
    sessionId: string
    deadline: number
  } | null>(null)
  const { client, state } = useHostClient(destination?.route.hostId)

  useEffect(() => {
    setDestination(null)
    if (!pending) {
      return
    }
    let disposed = false
    void (async () => {
      const route = await nativeLiveActivities?.route(
        pending.scope ? pending.id + '.' + pending.scope : pending.id
      )
      const hosts = await loadHostCatalog()
      const host = hosts.find((entry) => entry.id === route?.hostId)
      if (disposed) {
        return
      }
      router.dismissTo('/')
      if (!route || !host || !pending.scope || !pending.session || !route.activityId) {
        return
      }
      const target = getNotificationNavigationTarget(
        { hostId: route.hostId },
        {
          knownHostIds: new Set(hosts.map((entry) => entry.id)),
          credentialStatusByHostId: new Map(
            hosts.map((entry) => [entry.id, entry.credentialStatus])
          )
        }
      )
      if (target?.credentialRecovery) {
        open(target)
        return
      }
      setDestination({
        route: { ...route, activityId: route.activityId },
        deadline: Date.now() + 10_000,
        sessionId: pending.session
      })
    })().catch(() => {
      if (!disposed) {
        router.dismissTo('/')
      }
    })
    return () => {
      disposed = true
    }
  }, [pending, open, router])

  useEffect(() => {
    if (!destination) {
      return
    }
    let disposed = false
    const { route, sessionId, deadline } = destination
    const fallback = (): void => {
      if (disposed) {
        return
      }
      disposed = true
      setDestination(null)
      const target = getNotificationNavigationTarget({ hostId: route.hostId })
      if (target) {
        open(target)
      }
    }
    const timer = setTimeout(fallback, Math.max(0, deadline - Date.now()))
    const cleanup = (): void => {
      disposed = true
      clearTimeout(timer)
    }
    if (!client || state !== 'connected' || deadline <= Date.now()) {
      return cleanup
    }
    void resolveLiveActivitySession
      .request(
        client,
        { activityId: route.activityId, sessionId },
        {
          timeoutMs: Math.max(1, deadline - Date.now()),
          failWhenDisconnected: true,
          ...(route.executionHost ? { envelope: { executionHost: route.executionHost } } : {})
        }
      )
      .then((reply) => {
        const result = resolveLiveActivitySession.interpret(reply)
        const target = getNotificationNavigationTarget({
          hostId: route.hostId,
          ...(result.accepted && result.value.target ? result.value.target : {}),
          ...(route.executionHost ? { executionHost: route.executionHost } : {})
        })
        if (!disposed) {
          disposed = true
          clearTimeout(timer)
          setDestination(null)
          if (target) {
            open(target)
          }
        }
      })
      .catch(() => {
        clearTimeout(timer)
        fallback()
      })
    return cleanup
  }, [destination, client, state, open])
}
