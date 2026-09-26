import {
  ORCHESTRATION_FLEET_PAGE_MAX,
  projectOrchestrationFleet,
  type FleetDurableWorker
} from '../../../../../../shared/orchestration-fleet-projection'
import { resolveFleetWorkerOutcome } from '../../../../../../shared/orchestration-fleet-outcome-resolution'
import type { WorkerTerminalListState } from '../../../../orchestration/worker-terminal-ownership'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { observeStructuredAssignee } from '../../../../structured-worker-authority'
import { applyExecutionHostVerdict } from './fleet-execution-host-verdict'
import { structuredAgentSessionLeadState } from '../../../../../../shared/structured-agent-session-agent-status'
import type { StructuredAgentSessionProjectedStatus } from '../../../../../../shared/structured-agent-session-projection'

export type WorkerListPageParams = {
  run?: string
  terminalState?: WorkerTerminalListState
  includeRemote?: boolean
  paginate?: boolean
}

export function projectWorkerFleet(args: {
  /** Reads a structured session's liveness off this runtime's own session host. */
  db: OrchestrationDb
  /** A structured session's status, as `@idle` reads it (`getAgentStatusForHandle`). */
  agentStatus: (handle: string) => string | null
  rows: ReturnType<OrchestrationDb['listWorkerTerminalResources']>
  attentionFacts: ReturnType<OrchestrationDb['getWorkerAttentionFactsForDispatches']>
  statuses: Parameters<typeof projectOrchestrationFleet>[0]['statuses']
  limit: number
  now: number
  completeProjection?: boolean
}) {
  const workers: FleetDurableWorker[] = args.rows.map((row) => {
    return {
      ...row,
      outcome: resolveFleetWorkerOutcome({
        attemptOutcome: args.attentionFacts.get(row.dispatchId)?.outcome ?? 'outcome_unknown',
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
            updatedAt: row.resource.updated_at
          }
        : null
    }
  })
  const durable = new Map(workers.map((worker) => [worker.dispatchId, worker]))
  if (!args.completeProjection) {
    const page = projectOrchestrationFleet({
      workers,
      statuses: args.statuses,
      limit: args.limit,
      now: args.now
    })
    applyStructuredSessionVerdicts(page.workers, durable, args)
    return { ...page, durable }
  }

  const projections: ReturnType<typeof projectOrchestrationFleet>['workers'] = []
  for (let offset = 0; offset < workers.length; offset += ORCHESTRATION_FLEET_PAGE_MAX) {
    projections.push(
      ...projectOrchestrationFleet({
        workers: workers.slice(offset, offset + ORCHESTRATION_FLEET_PAGE_MAX),
        statuses: args.statuses,
        limit: ORCHESTRATION_FLEET_PAGE_MAX,
        now: args.now
      }).workers
    )
  }
  applyStructuredSessionVerdicts(projections, durable, args)
  return {
    workers: projections,
    page: { limit: workers.length, total: workers.length, hasMore: false, nextCursor: null },
    durable
  }
}

/**
 * A worker that is a structured session — a minted worker or a chat — has no pane, so no
 * agent-status row can ever bind to it. Its liveness is the session host's own verdict, the same
 * observation worker-show reports.
 */
function applyStructuredSessionVerdicts(
  projected: ReturnType<typeof projectOrchestrationFleet>['workers'],
  durable: ReadonlyMap<string, FleetDurableWorker>,
  host: {
    db: OrchestrationDb
    now: number
    agentStatus: (handle: string) => string | null
  }
): void {
  for (const worker of projected) {
    const handle = durable.get(worker.dispatchId)?.agentTerminalHandle
    const observation = handle ? observeStructuredAssignee(handle, host.db) : null
    if (handle && observation) {
      const status = PROJECTED_STATUSES.find((known) => known === host.agentStatus(handle))
      applyExecutionHostVerdict(
        worker,
        {
          ...observation,
          ...(status ? { activity: structuredAgentSessionLeadState(status) } : {})
        },
        host.now,
        durable
      )
    }
  }
}

const PROJECTED_STATUSES: readonly StructuredAgentSessionProjectedStatus[] = [
  'working',
  'attention',
  'idle'
]
