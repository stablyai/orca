import type { HostStackRouteTarget } from '../navigation/host-stack-navigation'
import type { TaskProvider } from '../../../src/shared/work-items/task-providers'

export function mobileTasksRouteTarget(
  hostId: string,
  provider?: TaskProvider
): HostStackRouteTarget {
  return {
    name: '[hostId]/tasks',
    params: provider ? { hostId, taskSource: provider } : { hostId }
  }
}
