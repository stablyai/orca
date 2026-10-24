import { useCallback, useEffect, useRef } from 'react'
import { useNavigation, useNavigationContainerRef, useRouter } from 'expo-router'
import {
  coordinateHostStackNavigation,
  landOnWorkspace,
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
  // Why: an unmounting screen may only cancel a transition it armed itself — home
  // unmounting for onboarding must not kill a notification push still in flight.
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

// Why: a cold tap's root-layout navigation sees the root stack as a stale partial state and is
// never told when it commits; the container reads the hydrated tree and hears every commit.
function containerNavigation(
  container: ReturnType<typeof useNavigationContainerRef>
): HostStackRootNavigation {
  return {
    addListener: (event, listener) => container.addListener(event, listener),
    dispatch: (action) => container.dispatch(action),
    getState: () => (container.isReady() ? container.getRootState() : undefined)
  }
}

/** Opens a push-tapped workspace, taking over whatever transition was pending. */
export function useLandOnWorkspace(): (hostId: string, target: HostStackRouteTarget) => void {
  const container = useNavigationContainerRef()
  return useCallback(
    (hostId, target) => {
      pendingNavigation?.controller.cancel()
      pendingNavigation = {
        hostId,
        controller: landOnWorkspace(containerNavigation(container), hostId, target)
      }
    },
    [container]
  )
}
