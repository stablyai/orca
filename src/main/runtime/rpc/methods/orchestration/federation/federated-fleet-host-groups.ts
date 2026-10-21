import { ORCHESTRATION_FLEET_PAGE_MAX } from '../../../../../../shared/orchestration-fleet-projection'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { FederatedDispatchRow } from '../../../../orchestration/types'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

type HostGroup = {
  environmentId: string
  name: string
  dispatches: FederatedDispatchRow[]
}

export function groupFederatedDispatches(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchIds: readonly string[]
}): HostGroup[] {
  const groups = new Map<string, HostGroup>()
  const federatedByDispatchId = new Map(
    args.db
      .listFederatedDispatchesByIds(args.dispatchIds)
      .map((dispatch) => [dispatch.dispatch_id, dispatch])
  )
  for (const dispatchId of args.dispatchIds) {
    const dispatch = federatedByDispatchId.get(dispatchId)
    if (!dispatch) {
      continue
    }
    const groupKey = `${dispatch.environment_id}\u0000${dispatch.peer_fingerprint}`
    const group = groups.get(groupKey) ?? {
      environmentId: dispatch.environment_id,
      name: dispatch.environment_name,
      dispatches: []
    }
    group.dispatches.push(dispatch)
    groups.set(groupKey, group)
  }
  return [...groups.values()].flatMap((group) => {
    const batches: HostGroup[] = []
    for (let offset = 0; offset < group.dispatches.length; offset += ORCHESTRATION_FLEET_PAGE_MAX) {
      batches.push({
        ...group,
        dispatches: group.dispatches.slice(offset, offset + ORCHESTRATION_FLEET_PAGE_MAX)
      })
    }
    return batches
  })
}
