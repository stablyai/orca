import type { HostStackRouteTarget } from '../navigation/host-stack-navigation'

/** Host id stays raw — the navigator owns the params, so pre-encoding one would
 *  reach the accounts screen still escaped. */
export function mobileAccountsRouteTarget(hostId: string): HostStackRouteTarget {
  return {
    name: '[hostId]/accounts',
    params: { hostId }
  }
}
