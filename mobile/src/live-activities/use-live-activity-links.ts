import { useEffect } from 'react'
import { useRouter } from 'expo-router'
import { nativeLiveActivities } from './native-live-activities'
import { usePendingLiveActivityLink } from './pending-live-activity-link'
import { loadHostCatalog } from '../host-catalog/host-store'
import { getNotificationNavigationTarget } from '../notifications/navigation/notification-routing'
import { useOpenNotificationRoute } from '../notifications/navigation/use-open-notification-route'

export function useLiveActivityLinks(): void {
  const pending = usePendingLiveActivityLink()
  const open = useOpenNotificationRoute()
  const router = useRouter()
  useEffect(() => {
    if (!pending) {
      return
    }
    let disposed = false
    void (async () => {
      const route = await nativeLiveActivities?.route(pending.id)
      const hosts = await loadHostCatalog()
      const target =
        route &&
        getNotificationNavigationTarget(route, {
          knownHostIds: new Set(hosts.map((host) => host.id)),
          credentialStatusByHostId: new Map(hosts.map((host) => [host.id, host.credentialStatus]))
        })
      if (disposed) {
        return
      }
      router.dismissTo('/')
      if (target) {
        open(target)
      }
    })().catch(() => {
      if (!disposed) {
        router.dismissTo('/')
      }
    })
    return () => {
      disposed = true
    }
  }, [pending, open, router])
}
