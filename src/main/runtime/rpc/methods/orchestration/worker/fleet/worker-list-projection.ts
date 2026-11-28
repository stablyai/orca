import {
  ORCHESTRATION_FLEET_PAGE_MAX,
  projectOrchestrationFleet,
  type FleetDurableWorker
} from '../../../../../../../shared/orchestration/fleet/orchestration-fleet-projection'
import type { WorkerTerminalListState } from '../../../../../orchestration/terminal-authority/release/worker-terminal-ownership'
import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../../orca-runtime'
import {
  createSessionWorkerLivenessReader,
  withSleptAgentWorkers
} from '../../../../../orchestration/workers/lifecycle/session-worker-liveness'
import {
  applyFederatedFleetObservations,
  readFederatedFleetSnapshots
} from '../../../../../orchestration/legacy-remote-home/federated-fleet-snapshot'
import { ensureSessionWorkerRecords } from '../observation/session-worker-observation'
import { projectDurableWorker } from './fleet-durable-worker'
import { confirmStaleWorkerAgentProcesses } from './fleet-agent-process-confirmation'

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
  const workers: FleetDurableWorker[] = args.rows.map((row) =>
    projectDurableWorker(row, args.attentionFacts)
  )
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
  await ensureSessionWorkerRecords(runtime, rows)
  const attentionFacts = db.getWorkerAttentionFactsForDispatches(
    rows.map((row) => row.dispatchId),
    now
  )
  // A quiet idle worker keeps its last hook row; re-probe that row's process before calling it stale.
  const statuses = await confirmStaleWorkerAgentProcesses({
    rows,
    attentionFacts,
    statuses: runtime.getOrchestrationFleetAgentStatusSnapshot(),
    now,
    checkPresence: (paneKey) => runtime.checkHookAgentPresence(paneKey)
  })
  const fleet = projectWorkerFleet({
    rows,
    attentionFacts,
    statuses,
    limit: options.limit,
    now,
    completeProjection: options.completeProjection,
    observeSession: withSleptAgentWorkers(
      createSessionWorkerLivenessReader(db, statuses, undefined, {
        includeResumeGuidance: true
      }),
      statuses,
      (paneKey) => runtime.sleptAgentHandleForPane(paneKey)
    )
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
