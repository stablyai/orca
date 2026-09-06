import { useCallback } from 'react'
import { useRouter } from 'expo-router'
import { useOpenHostStackRoute } from '../navigation/use-open-host-stack-route'
import { navigateFromMobileHome } from './mobile-web-home-navigation'
import type {
  MobileWebNavigationIntent,
  MobileWebNavigationIntentTarget
} from './mobile-web-navigation-intent-buffer'

/** The one entry point for "open this host target": publishes the hybrid navigation intent and
 *  then either pushes `/hybrid` or drives the native host stack through its coordinator. */
export function useOpenMobileHostTarget(): (
  hostId: string,
  target: MobileWebNavigationIntentTarget,
  source?: MobileWebNavigationIntent['source']
) => void {
  const router = useRouter()
  const openHostStackRoute = useOpenHostStackRoute()

  return useCallback(
    (hostId, target, source) => {
      navigateFromMobileHome({ router, openHostStackRoute, hostId, target, source })
    },
    [openHostStackRoute, router]
  )
}
