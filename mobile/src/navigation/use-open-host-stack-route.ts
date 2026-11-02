import { useCallback, useEffect, useRef } from 'react'
import { useNavigation, useRouter } from 'expo-router'
import {
  coordinateHostStackNavigation,
  type HostStackRootNavigation,
  type HostStackRouteTarget,
  type PendingHostStackNavigation
} from './host-stack-navigation'

// One root navigator needs one pending transition so Resume and Tasks pushes can cancel each other.
let pendingNavigation: PendingHostStackNavigation | null = null

export function useOpenHostStackRoute(): (hostId: string, target: HostStackRouteTarget) => void {
  const navigation = useNavigation<HostStackRootNavigation>()
  const router = useRouter()
  // Unmount may cancel only its own transition, never another screen’s notification push.
  const armedRef = useRef<PendingHostStackNavigation | null>(null)

  useEffect(
    () => () => {
      if (armedRef.current && armedRef.current === pendingNavigation) {
        pendingNavigation.controller.cancel()
        pendingNavigation = null
      }
      armedRef.current = null
    },
    []
  )

  return useCallback(
    (hostId, target) => {
      pendingNavigation = coordinateHostStackNavigation(
        pendingNavigation,
        navigation,
        router,
        hostId,
        target
      )
      armedRef.current = pendingNavigation
    },
    [navigation, router]
  )
}
