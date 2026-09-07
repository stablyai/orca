import { useCallback } from 'react'
import { useOpenHostStackRoute } from '../navigation/use-open-host-stack-route'
import { mobileSessionRouteTarget, type MobileSessionRouteParams } from './mobile-session-route'

export function useOpenMobileSession(): (params: MobileSessionRouteParams) => void {
  const openHostStackRoute = useOpenHostStackRoute()

  return useCallback(
    (params) => {
      openHostStackRoute(params.hostId, mobileSessionRouteTarget(params))
    },
    [openHostStackRoute]
  )
}
