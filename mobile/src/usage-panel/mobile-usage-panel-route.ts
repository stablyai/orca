import type { HostStackRouteTarget } from '../navigation/host-stack-navigation'

// Keep host id raw: navigator owns params and pre-encoding would leave it escaped on arrival.
export function mobileUsagePanelRouteTarget(hostId: string): HostStackRouteTarget {
  return {
    name: '[hostId]/usage-panel',
    params: { hostId }
  }
}
