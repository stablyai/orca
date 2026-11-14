import {
  ORCHESTRATION_FLEET_PAGE_MAX,
  projectOrchestrationFleet,
  type FleetDurableWorker
} from '../../../../../../../shared/orchestration/fleet/orchestration-fleet-projection'
import { resolveFleetWorkerOutcome } from '../../../../../../../shared/orchestration/fleet/orchestration-fleet-outcome-resolution'
import {
  liveWorkerTerminalAutoReleaseAt,
  type WorkerTerminalListState
} from '../../../../../orchestration/terminal-authority/release/worker-terminal-ownership'
import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../../orca-runtime'
import { createSessionWorkerLivenessReader } from '../../../../../orchestration/workers/lifecycle/session-worker-liveness'
import {
  applyFederatedFleetObservations,
  readFederatedFleetSnapshots
} from '../../../../../orchestration/legacy-remote-home/federated-fleet-snapshot'
import { ensureSessionWorkerRecords } from '../observation/session-worker-observation'

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
  observeSession?: Parameters<typeof projectOrchestrationFleet>[0]['observeSession']
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
            autoReleaseAt: liveWorkerTerminalAutoReleaseAt(row.resource),
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
        observeSession: args.observeSession,
        limit: args.limit,
        now: args.now
      }),
      durable
    }
    return fleet
  }

  const projections: ReturnType<typeof projectOrchestrationFleet>['workers'] = []
  for (let offset = 0; offset < workers.length; offset += ORCHESTRATION_FLEET_PAGE_MAX) {
    projections.push(
      ...projectOrchestrationFleet({
        workers: workers.slice(offset, offset + ORCHESTRATION_FLEET_PAGE_MAX),
        statuses: args.statuses,
        observeSession: args.observeSession,
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
  return fleet
}

/** worker-list's projection of these rows; includeRemote layers on execution-host verdicts. */
export async function projectWorkerListFleet(
  runtime: OrcaRuntimeService,
  rows: ReturnType<OrchestrationDb['listWorkerTerminalResources']>,
  options: { limit: number; completeProjection?: boolean; includeRemote?: boolean }
) {
  const db = runtime.getOrchestrationDb()
  const now = Date.now()
  const statuses = runtime.getOrchestrationFleetAgentStatusSnapshot()
  await ensureSessionWorkerRecords(runtime, rows)
  const fleet = projectWorkerFleet({
    rows,
    attentionFacts: db.getWorkerAttentionFactsForDispatches(
      rows.map((row) => row.dispatchId),
      now
    ),
    statuses,
    limit: options.limit,
    now,
    completeProjection: options.completeProjection,
    observeSession: createSessionWorkerLivenessReader(db, statuses)
  })
  const federated = options.includeRemote
    ? await readFederatedFleetSnapshots({
        runtime,
        db,
        dispatchIds: rows.map((row) => row.dispatchId)
      })
    : null
  if (federated) {
    applyFederatedFleetObservations(fleet, federated, fleet.durable)
  }
  return { ...fleet, hostErrors: federated?.errors ?? [] }
}
