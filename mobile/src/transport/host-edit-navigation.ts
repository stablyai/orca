import {
  hostStackHostRoute,
  navigateToHostStackRoute,
  type HostStackHostRoute,
  type HostStackNavigationController,
  type HostStackNavigationState,
  type HostStackRootNavigation,
  type HostStackRouteTarget,
  type HostStackRouter
} from '../navigation/host-stack-navigation'

export type MobileHostEditHostRoute = HostStackHostRoute
export type MobileHostEditNavigationState = HostStackNavigationState
export type MobileHostEditRootNavigation = HostStackRootNavigation
export type MobileHostEditRouter = HostStackRouter
export type MobileHostEditNavigationController = HostStackNavigationController

export function mobileHostEditHostRoute(hostId: string): MobileHostEditHostRoute {
  return hostStackHostRoute(hostId)
}

export function mobileHostEditRouteTarget(hostId: string): HostStackRouteTarget {
  return {
    name: '[hostId]/edit',
    params: { hostId }
  }
}

export function navigateToMobileHostEdit(
  navigation: MobileHostEditRootNavigation,
  router: MobileHostEditRouter,
  hostId: string
): MobileHostEditNavigationController {
  return navigateToHostStackRoute(navigation, router, hostId, mobileHostEditRouteTarget(hostId))
}
