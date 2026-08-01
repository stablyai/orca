import { useCallback, useEffect, useRef } from 'react'
import { useNavigation, useRouter } from 'expo-router'
import {
  coordinateHostStackNavigation,
  type HostStackRootNavigation,
  type HostStackRouteTarget,
  type PendingHostStackNavigation
} from './host-stack-navigation'

export function useOpenHostStackRoute(): (hostId: string, target: HostStackRouteTarget) => void {
  const navigation = useNavigation<HostStackRootNavigation>()
  const router = useRouter()
  const pendingRef = useRef<PendingHostStackNavigation | null>(null)

  useEffect(
    () => () => {
      pendingRef.current?.controller.cancel()
      pendingRef.current = null
    },
    []
  )

  return useCallback(
    (hostId, target) => {
      pendingRef.current = coordinateHostStackNavigation(
        pendingRef.current,
        navigation,
        router,
        hostId,
        target
      )
    },
    [navigation, router]
  )
}
