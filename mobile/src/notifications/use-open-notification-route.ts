import { useCallback } from 'react'
import { useRouter } from 'expo-router'
import { hostStackHostRoute } from '../navigation/host-stack-navigation'
import { useOpenHostStackRoute } from '../navigation/use-open-host-stack-route'
import { dispatchInPageNotificationNavigation } from './in-page-notification-navigation'
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
      if (recoveryRoute) {
        router.push(recoveryRoute)
        return
      }
      if (target.sessionTarget) {
        if (
          dispatchInPageNotificationNavigation({
            hostId: target.hostId,
            worktreeId: target.sessionTarget.params.worktreeId,
            paneKey: target.sessionTarget.params.paneKey,
            executionHost: target.sessionTarget.params.executionHost
          })
        ) {
          return
        }
        openHostStackRoute(target.hostId, target.sessionTarget)
        return
      }
      router.push(hostStackHostRoute(target.hostId))
    },
    [openHostStackRoute, router]
  )
}
