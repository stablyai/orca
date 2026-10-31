import { useCallback } from 'react'
import { useOpenHostStackRoute } from '../navigation/use-open-host-stack-route'

export function useOpenMobileAutomations(): (hostId: string) => void {
  const openHostStackRoute = useOpenHostStackRoute()
  return useCallback(
    (hostId) => openHostStackRoute(hostId, { name: '[hostId]/automations', params: { hostId } }),
    [openHostStackRoute]
  )
}
