import { useCallback } from 'react'
import { useOpenHostStackRoute } from '../navigation/use-open-host-stack-route'
import { mobileAccountsRouteTarget } from './mobile-accounts-route'

export function useOpenMobileAccounts(): (hostId: string) => void {
  const openHostStackRoute = useOpenHostStackRoute()
  return useCallback(
    (hostId) => openHostStackRoute(hostId, mobileAccountsRouteTarget(hostId)),
    [openHostStackRoute]
  )
}

/** Opens one host's Accounts from a screen that navigates through its own router, as the page does. */
export function useOpenHostAccounts(
  router: { push: (href: string) => void },
  hostId: string
): () => void {
  return useCallback(
    () => router.push(`/h/${encodeURIComponent(hostId)}/accounts`),
    [router, hostId]
  )
}
