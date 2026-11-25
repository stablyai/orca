import {
  navigateToHostStackRoute,
  type HostStackNavigationController,
  type HostStackRootNavigation,
  type HostStackRouteTarget,
  type HostStackRouter
} from '../../navigation/host-stack-navigation'

export function mobileHostEditRouteTarget(hostId: string): HostStackRouteTarget {
  return {
    name: '[hostId]/edit',
    params: { hostId }
  }
}

export function navigateToMobileHostEdit(
  navigation: HostStackRootNavigation,
  router: HostStackRouter,
  hostId: string
): HostStackNavigationController {
  return navigateToHostStackRoute(navigation, router, hostId, mobileHostEditRouteTarget(hostId))
}
