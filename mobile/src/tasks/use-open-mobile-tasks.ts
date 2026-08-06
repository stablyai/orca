import { useCallback } from 'react'
import { useOpenHostStackRoute } from '../navigation/use-open-host-stack-route'
import { mobileTasksRouteTarget } from './mobile-task-navigation'
import type { TaskProvider } from './mobile-task-providers'

export function useOpenMobileTasks(): (hostId: string, provider?: TaskProvider) => void {
  const openHostStackRoute = useOpenHostStackRoute()

  return useCallback(
    (hostId, provider) => {
      openHostStackRoute(hostId, mobileTasksRouteTarget(hostId, provider))
    },
    [openHostStackRoute]
  )
}
