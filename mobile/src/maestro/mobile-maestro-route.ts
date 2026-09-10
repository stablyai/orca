import type { HostStackRouteTarget } from '../navigation/host-stack-navigation'

export function mobileMaestroRouteTarget(params: {
  hostId: string
  executionHostId: string
  workspaceKey: string
  name?: string
}): HostStackRouteTarget {
  return {
    name: '[hostId]/maestro/[workspaceKey]',
    params: params.name
      ? {
          hostId: params.hostId,
          executionHostId: params.executionHostId,
          workspaceKey: params.workspaceKey,
          name: params.name
        }
      : {
          hostId: params.hostId,
          executionHostId: params.executionHostId,
          workspaceKey: params.workspaceKey
        }
  }
}
