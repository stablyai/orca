import { useCallback } from 'react'
import { useOpenHostStackRoute } from '../navigation/use-open-host-stack-route'
import { mobileAccountsRouteTarget } from './mobile-accounts-route'

export function useOpenMobileAccounts(): (hostId: string) => void {
  const openHostStackRoute = useOpenHostStackRoute()

  return useCallback(
    (hostId) => {
      openHostStackRoute(hostId, mobileAccountsRouteTarget(hostId))
    },
    [openHostStackRoute]
  )
}
