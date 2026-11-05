import { useCallback } from 'react'
import { useOpenHostStackRoute } from '../navigation/use-open-host-stack-route'
import { mobileUsagePanelRouteTarget } from './mobile-usage-panel-route'

export function useOpenMobileUsagePanel(): (hostId: string) => void {
  const openHostStackRoute = useOpenHostStackRoute()

  return useCallback(
    (hostId) => {
      openHostStackRoute(hostId, mobileUsagePanelRouteTarget(hostId))
    },
    [openHostStackRoute]
  )
}
