import type { HostStackRouteTarget } from '../navigation/host-stack-navigation'

// Keep host id raw: navigator owns params and pre-encoding would leave it escaped on arrival.
export function mobileResourceManagerRouteTarget(hostId: string): HostStackRouteTarget {
  return {
    name: '[hostId]/resource-manager',
    params: { hostId }
  }
}
