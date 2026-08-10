import { useCallback } from 'react'
import { useOpenHostStackRoute } from '../navigation/use-open-host-stack-route'
import { mobileHostEditRouteTarget } from './host-edit-navigation'

export function useOpenMobileHostEdit(): (hostId: string) => void {
  const openHostStackRoute = useOpenHostStackRoute()

  return useCallback(
    (hostId) => {
      openHostStackRoute(hostId, mobileHostEditRouteTarget(hostId))
    },
    [openHostStackRoute]
  )
}
