import type { HostStackRouteTarget } from '../navigation/host-stack-navigation'
import type { TaskProvider } from './mobile-task-providers'

/** Host id stays raw — the navigator owns the params, so pre-encoding one would
 *  reach the tasks screen still escaped. */
export function mobileTasksRouteTarget(
  hostId: string,
  provider?: TaskProvider
): HostStackRouteTarget {
  return {
    name: '[hostId]/tasks',
    params: provider ? { hostId, taskSource: provider } : { hostId }
  }
}
