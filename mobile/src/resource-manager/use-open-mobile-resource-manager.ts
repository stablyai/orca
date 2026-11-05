import { useCallback } from 'react'
import { useOpenHostStackRoute } from '../navigation/use-open-host-stack-route'
import { mobileResourceManagerRouteTarget } from './mobile-resource-manager-route'

export function useOpenMobileResourceManager(): (hostId: string) => void {
  const openHostStackRoute = useOpenHostStackRoute()

  return useCallback(
    (hostId) => {
      openHostStackRoute(hostId, mobileResourceManagerRouteTarget(hostId))
    },
    [openHostStackRoute]
  )
}
