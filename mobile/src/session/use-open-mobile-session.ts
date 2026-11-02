import { createPersonalProjectRouteIntent } from '../worktree/personal-project-route-intent'
import { useCallback } from 'react'
import { useOpenHostStackRoute } from '../navigation/use-open-host-stack-route'
import { mobileSessionRouteTarget, type MobileSessionRouteParams } from './mobile-session-route'

export function useOpenMobileSession(): (params: MobileSessionRouteParams) => void {
  const openHostStackRoute = useOpenHostStackRoute()

  return useCallback(
    async (params) => {
      const projectOpen = await createPersonalProjectRouteIntent(params.hostId)
      openHostStackRoute(params.hostId, mobileSessionRouteTarget({ ...params, projectOpen }))
    },
    [openHostStackRoute]
  )
}
