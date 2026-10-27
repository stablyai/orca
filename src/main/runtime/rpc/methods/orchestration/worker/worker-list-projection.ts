import {
  ORCHESTRATION_FLEET_PAGE_MAX,
  projectOrchestrationFleet,
  type FleetDurableWorker,
  type OrchestrationFleetWorker
} from '../../../../../../shared/orchestration-fleet-projection'
import { resolveFleetWorkerOutcome } from '../../../../../../shared/orchestration-fleet-outcome-resolution'
import type { WorkerTerminalListState } from '../../../../orchestration/worker-terminal-ownership'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { refreshFleetWorkerVerdict } from '../federation/federated-fleet-snapshot'
import type { FleetSessionObserver } from './session-worker-observation'

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
  /** Session workers' verdicts; agent-status rows bind to terminals, which chat and structured workers lack. */
  observeSession?: FleetSessionObserver
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
    applySessionWorkerLiveness(fleet, args.observeSession, args.now)
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
  applySessionWorkerLiveness(fleet, args.observeSession, args.now)
  return fleet
}

/** Read off the session records, as worker-show and mail read them: at rest is live, closed exited. */
function applySessionWorkerLiveness(
  fleet: { workers: OrchestrationFleetWorker[]; durable: ReadonlyMap<string, FleetDurableWorker> },
  observeSession: FleetSessionObserver | undefined,
  now: number
): void {
  for (const worker of observeSession ? fleet.workers : []) {
    const handle = fleet.durable.get(worker.dispatchId)?.agentTerminalHandle
    // A durable death certificate (a stop, a release) outranks a read of the records.
    const observed =
      handle && observeSession && worker.liveness.verdict !== 'exited'
        ? observeSession(worker.dispatchId, handle)
        : null
    if (!observed) {
      continue
    }
    const live = observed.status === 'live'
    worker.liveness = live
      ? { verdict: 'live', observedAt: now, source: 'execution_host' }
      : observed.status === 'exited'
        ? { verdict: 'exited', source: 'execution_host' }
        : { verdict: 'unverifiable', reason: 'host_indeterminate' }
    worker.evidence.liveStatus = live ? 'fresh' : 'unavailable'
    worker.evidence.lastObservedAt = live ? now : null
    worker.provider = observed.published?.provider ?? worker.provider
    worker.stage.activity = live ? (observed.published?.activity ?? 'unknown') : 'unknown'
    refreshFleetWorkerVerdict(worker, fleet.durable)
  }
}
