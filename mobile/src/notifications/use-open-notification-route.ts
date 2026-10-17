import { useCallback } from 'react'
import { useRouter } from 'expo-router'
import { hostStackHostRoute } from '../navigation/host-stack-navigation'
import { useLandOnWorkspace } from '../navigation/use-open-host-stack-route'
import {
  notificationCredentialRecoveryRoute,
  type NotificationNavigationTarget
} from './notification-routing'

export function useOpenNotificationRoute(): (target: NotificationNavigationTarget) => void {
  const landOnWorkspace = useLandOnWorkspace()
  const router = useRouter()

  return useCallback(
    (target) => {
      const recoveryRoute = notificationCredentialRecoveryRoute(target)
      if (recoveryRoute) {
        router.push(recoveryRoute)
        return
      }
      if (target.sessionTarget) {
        landOnWorkspace(target.hostId, target.sessionTarget)
        return
      }
      router.push(hostStackHostRoute(target.hostId))
    },
    [landOnWorkspace, router]
  )
}
