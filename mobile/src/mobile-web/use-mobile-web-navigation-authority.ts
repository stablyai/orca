import { useMemo, type RefObject } from 'react'
import { leaveHostRoute } from '../host-route-exit'
import { removeHostAndCloseClient } from '../transport/host-removal-lifecycle'
import {
  isMobileWebNativeRoute,
  type MobileWebNativeRouteHandoff
} from './mobile-web-native-route-handoff'
import type { MobileWebNavigationAuthority } from './mobile-web-navigation-operations'

type MobileWebShellRouter = {
  dismissTo: (href: '/') => void
  push: (href: '/pair-scan') => void
}

export function useMobileWebNavigationAuthority({
  hostId,
  hostPublicKeyB64,
  routeHandoffRef,
  router,
  clearColdResumeRoute,
  closeHostClient,
  forceReconnectHost
}: {
  hostId: string | undefined
  hostPublicKeyB64: string | undefined
  routeHandoffRef: RefObject<MobileWebNativeRouteHandoff>
  router: MobileWebShellRouter
  clearColdResumeRoute: () => void
  closeHostClient: (hostId: string) => void
  forceReconnectHost: (hostId: string) => void | Promise<void>
}): MobileWebNavigationAuthority | undefined {
  return useMemo(() => {
    if (!hostId || !hostPublicKeyB64) {
      return undefined
    }
    return {
      route(destination, requestId) {
        // Shell-owned screens keep the hosted page mounted; only host exits clear it.
        if (isMobileWebNativeRoute(destination)) {
          routeHandoffRef.current.record(requestId, destination)
          return
        }
        clearColdResumeRoute()
        if (destination === 'hostPicker') {
          leaveHostRoute(router)
        } else {
          router.push('/pair-scan')
        }
      },
      reconnect() {
        return forceReconnectHost(hostId)
      },
      removeHost() {
        // The hosted document is served out of the host's package cache that the unpair deletes,
        // so leave the route first instead of letting the hosts-list change unmount the view later.
        clearColdResumeRoute()
        leaveHostRoute(router)
        return removeHostAndCloseClient(hostId, hostPublicKeyB64, closeHostClient)
      }
    }
  }, [
    clearColdResumeRoute,
    closeHostClient,
    forceReconnectHost,
    hostId,
    hostPublicKeyB64,
    routeHandoffRef,
    router
  ])
}
