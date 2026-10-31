import { useCallback } from 'react'
import { useRouter } from 'expo-router'
import { hostStackHostRoute } from '../navigation/host-stack-navigation'
import {
  cancelPendingHostStackRoute,
  useOpenHostStackRoute
} from '../navigation/use-open-host-stack-route'
import {
  notificationCredentialRecoveryRoute,
  type NotificationNavigationTarget
} from './notification-routing'

export function useOpenNotificationRoute(): (target: NotificationNavigationTarget) => void {
  const openHostStackRoute = useOpenHostStackRoute()
  const router = useRouter()

  return useCallback(
    (target) => {
      const recoveryRoute = notificationCredentialRecoveryRoute(target)
      if (target.sessionTarget && !recoveryRoute) {
        openHostStackRoute(target.hostId, target.sessionTarget)
        return
      }
      cancelPendingHostStackRoute()
      if ('home' in target) {
        router.push('/')
        return
      }
      if (recoveryRoute) {
        router.push(recoveryRoute)
        return
      }
      router.push(hostStackHostRoute(target.hostId))
    },
    [openHostStackRoute, router]
  )
}
