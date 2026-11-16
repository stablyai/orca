import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useNavigation, useNavigationContainerRef, useRouter } from 'expo-router'
import {
  coordinateHostStackNavigation,
  type HostStackRootNavigation,
  type HostStackRouteTarget,
  type PendingHostStackNavigation
} from './host-stack-navigation'

// One root navigator needs one pending transition so Resume and Tasks pushes can cancel each other.
let pendingNavigation: PendingHostStackNavigation | null = null

// Jump back in and notification taps open a session inside its host's document instead of a second one.
export function useOpenHostStackRoute(
  openInHostDocument = false
): (hostId: string, target: HostStackRouteTarget) => void {
  const screenNavigation = useNavigation<HostStackRootNavigation>()
  const container = useNavigationContainerRef()
  // Read the whole tree: a navigator's own state omits a freshly mounted host stack until that stack next changes.
  const navigation = useMemo<HostStackRootNavigation>(
    () => ({
      addListener: (event, listener) => screenNavigation.addListener(event, listener),
      dispatch: (action) => screenNavigation.dispatch(action),
      getState: () => (container.isReady() ? container.getRootState() : undefined)
    }),
    [container, screenNavigation]
  )
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
        target,
        openInHostDocument
      )
      armedRef.current = pendingNavigation
    },
    [navigation, openInHostDocument, router]
  )
}
