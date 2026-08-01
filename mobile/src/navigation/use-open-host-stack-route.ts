import { useCallback, useEffect } from 'react'
import { useNavigation, useRouter } from 'expo-router'
import {
  coordinateHostStackNavigation,
  type HostStackRootNavigation,
  type HostStackRouteTarget,
  type PendingHostStackNavigation
} from './host-stack-navigation'

// Why: one root navigator means one pending transition. A per-hook ref would let a
// Resume tap and a Tasks tap arm two independent pushes that cannot cancel each other.
let pendingNavigation: PendingHostStackNavigation | null = null

export function useOpenHostStackRoute(): (hostId: string, target: HostStackRouteTarget) => void {
  const navigation = useNavigation<HostStackRootNavigation>()
  const router = useRouter()

  useEffect(
    () => () => {
      pendingNavigation?.controller.cancel()
      pendingNavigation = null
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
    },
    [navigation, router]
  )
}
