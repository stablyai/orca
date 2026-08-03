import { useCallback, useEffect, useRef } from 'react'
import { useNavigation, useRouter } from 'expo-router'
import {
  coordinateMobileTasksNavigation,
  type MobileTasksRootNavigation,
  type PendingMobileTasksNavigation
} from './mobile-task-navigation'
import type { TaskProvider } from './mobile-task-providers'

export function useOpenMobileTasks(): (hostId: string, provider?: TaskProvider) => void {
  const navigation = useNavigation<MobileTasksRootNavigation>()
  const router = useRouter()
  const pendingRef = useRef<PendingMobileTasksNavigation | null>(null)

  useEffect(
    () => () => {
      pendingRef.current?.controller.cancel()
      pendingRef.current = null
    },
    []
  )

  return useCallback(
    (hostId, provider) => {
      pendingRef.current = coordinateMobileTasksNavigation(
        pendingRef.current,
        navigation,
        router,
        hostId,
        provider
      )
    },
    [navigation, router]
  )
}
