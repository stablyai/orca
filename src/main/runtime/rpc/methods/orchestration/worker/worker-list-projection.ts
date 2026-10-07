import {
  ORCHESTRATION_FLEET_PAGE_MAX,
  projectOrchestrationFleet,
  type FleetDurableWorker,
  type OrchestrationFleetWorker
} from '../../../../../../shared/orchestration-fleet-projection'
import { resolveFleetWorkerOutcome } from '../../../../../../shared/orchestration-fleet-outcome-resolution'
import type { WorkerTerminalListState } from '../../../../orchestration/worker-terminal-ownership'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { OrcaSessionId } from '../../../../../../shared/orca-session-address'
import {
  chatAssigneeSessionId,
  type ChatAssigneeObservation
} from '../../../../orchestration/chat-assignee'
import { refreshFleetWorkerVerdict } from '../federation/federated-fleet-snapshot'

export type WorkerListPageParams = {
  run?: string
  terminalState?: WorkerTerminalListState
  includeRemote?: boolean
  paginate?: boolean
}

export function projectWorkerFleet(args: {
  rows: ReturnType<OrchestrationDb['listWorkerTerminalResources']>
  attentionFacts: ReturnType<OrchestrationDb['getWorkerAttentionFactsForDispatches']>
  statuses: Parameters<typeof projectOrchestrationFleet>[0]['statuses']
  limit: number
  now: number
  completeProjection?: boolean
  /** A chat assignee's verdict; no agent-status row names a chat, so its reach stands in. */
  observeChat?: (sessionId: OrcaSessionId) => ChatAssigneeObservation
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
    const fleet = {
      ...projectOrchestrationFleet({
        workers,
        statuses: args.statuses,
        limit: args.limit,
        now: args.now
      }),
      durable
    }
    applyChatAssigneeLiveness(fleet, args.observeChat, args.now)
    return fleet
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
  const fleet = {
    workers: projections,
    page: { limit: workers.length, total: workers.length, hasMore: false, nextCursor: null },
    durable
  }
  applyChatAssigneeLiveness(fleet, args.observeChat, args.now)
  return fleet
}

/** Read off the session records, as worker-show and mail read it: at rest is live, closed exited. */
function applyChatAssigneeLiveness(
  fleet: { workers: OrchestrationFleetWorker[]; durable: ReadonlyMap<string, FleetDurableWorker> },
  observeChat: ((sessionId: OrcaSessionId) => ChatAssigneeObservation) | undefined,
  now: number
): void {
  for (const worker of observeChat ? fleet.workers : []) {
    const chat = chatAssigneeSessionId(fleet.durable.get(worker.dispatchId)?.agentTerminalHandle)
    // A durable death certificate (a stop, a release) outranks a read of the records.
    if (!chat || !observeChat || worker.liveness.verdict === 'exited') {
      continue
    }
    const observed = observeChat(chat)
    worker.liveness =
      observed.status === 'live'
        ? { verdict: 'live', observedAt: now, source: 'execution_host' }
        : observed.status === 'exited'
          ? { verdict: 'exited', source: 'execution_host' }
          : { verdict: 'unverifiable', reason: 'host_unavailable' }
    worker.evidence.liveStatus = observed.status === 'live' ? 'fresh' : 'unavailable'
    worker.evidence.lastObservedAt = observed.status === 'live' ? now : null
    refreshFleetWorkerVerdict(worker, fleet.durable)
  }
}
