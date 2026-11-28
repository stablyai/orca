import { resolveFleetWorkerOutcome } from '../../../../../../../shared/orchestration/fleet/orchestration-fleet-outcome-resolution'
import type { FleetDurableWorker } from '../../../../../../../shared/orchestration/fleet/orchestration-fleet-projection'
import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import { liveWorkerTerminalAutoReleaseAt } from '../../../../../orchestration/terminal-authority/release/worker-terminal-ownership'

export type WorkerListRow = ReturnType<OrchestrationDb['listWorkerTerminalResources']>[number]

export type WorkerAttentionFacts = ReturnType<
  OrchestrationDb['getWorkerAttentionFactsForDispatches']
>

/** The durable worker every fleet reader projects, from one inventory row. */
export function projectDurableWorker(
  row: WorkerListRow,
  attentionFacts: WorkerAttentionFacts
): FleetDurableWorker {
  return {
    ...row,
    outcome: resolveFleetWorkerOutcome({
      attemptOutcome: attentionFacts.get(row.dispatchId)?.outcome ?? 'outcome_unknown',
      workerState: row.workerState,
      dispatchStatus: row.dispatchStatus
    }),
    resource: row.resource
      ? {
          id: row.resource.id,
          ownerDispatchId: row.resource.owner_dispatch_id,
          worktreeId: row.resource.worktree_id,
          paneKey: row.resource.pane_key,
          processIncarnation: row.resource.process_incarnation,
          endpointId: row.resource.endpoint_id,
          endpointIncarnation: row.resource.endpoint_incarnation,
          hostScope: row.resource.host_scope,
          ownershipState: row.resource.ownership_state,
          releaseState: row.resource.release_state,
          autoReleaseAt: liveWorkerTerminalAutoReleaseAt(row.resource),
          updatedAt: row.resource.updated_at
        }
      : null,
    handedOn: row.handedOn && {
      toDispatchId: row.handedOn.toDispatchId,
      resource: row.handedOn.resource && {
        id: row.handedOn.resource.id,
        ownerDispatchId: row.handedOn.resource.owner_dispatch_id,
        releaseState: row.handedOn.resource.release_state
      }
    }
  }
}
