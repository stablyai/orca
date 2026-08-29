import {
  coordinateHostStackNavigation,
  hostStackHostRoute,
  navigateToHostStackRoute,
  type HostStackHostRoute,
  type HostStackNavigationController,
  type HostStackNavigationState,
  type HostStackRootNavigation,
  type HostStackRouteTarget,
  type HostStackRouter,
  type PendingHostStackNavigation
} from '../navigation/host-stack-navigation'
import type { TaskProvider } from './mobile-task-providers'

export type MobileTasksHostRoute = HostStackHostRoute
export type MobileTasksNavigationState = HostStackNavigationState
export type MobileTasksRootNavigation = HostStackRootNavigation
export type MobileTasksRouter = HostStackRouter
export type MobileTasksNavigationController = HostStackNavigationController
export type PendingMobileTasksNavigation = PendingHostStackNavigation

export function mobileTasksHostRoute(hostId: string): MobileTasksHostRoute {
  return hostStackHostRoute(hostId)
}

export function mobileTasksRouteTarget(
  hostId: string,
  provider?: TaskProvider
): HostStackRouteTarget {
  return {
    name: '[hostId]/tasks',
    params: provider ? { hostId, taskSource: provider } : { hostId }
  }
}

export function navigateToMobileTasks(
  navigation: MobileTasksRootNavigation,
  router: MobileTasksRouter,
  hostId: string,
  provider?: TaskProvider
): MobileTasksNavigationController {
  return navigateToHostStackRoute(
    navigation,
    router,
    hostId,
    mobileTasksRouteTarget(hostId, provider)
  )
}

export function coordinateMobileTasksNavigation(
  current: PendingMobileTasksNavigation | null,
  navigation: MobileTasksRootNavigation,
  router: MobileTasksRouter,
  hostId: string,
  provider?: TaskProvider
): PendingMobileTasksNavigation {
  return coordinateHostStackNavigation(
    current,
    navigation,
    router,
    hostId,
    mobileTasksRouteTarget(hostId, provider)
  )
}
