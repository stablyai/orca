import {
  ORCHESTRATION_FLEET_PAGE_MAX,
  projectOrchestrationFleet,
  type FleetDurableWorker,
  type OrchestrationFleetWorker
} from '../../../../../../shared/orchestration-fleet-projection'
import { resolveFleetWorkerOutcome } from '../../../../../../shared/orchestration-fleet-outcome-resolution'
import type { WorkerTerminalListState } from '../../../../orchestration/worker-terminal-ownership'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import {
  observeResolvedStructuredAssignee,
  resolveStructuredAssignee,
  type StructuredWorkerObservation
} from '../../../../structured-worker-authority'
import {
  applyExecutionHostVerdict,
  ensureSessionHostForStructuredRows
} from './fleet-execution-host-verdict'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../../../shared/structured-agent-session-projection'

export type WorkerListPageParams = {
  run?: string
  terminalState?: WorkerTerminalListState
  includeRemote?: boolean
  paginate?: boolean
}

export function projectWorkerFleet(args: {
  /** Reads a structured session's liveness off this runtime's own session host. */
  db: OrchestrationDb
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
 * agent-status row binds to it as a terminal's does. Its liveness is the session host's own
 * verdict, the same observation worker-show reports, and its activity is the agent-status store's
 * row for the session running it now (child work folded in), the row the sidebar and `worktree ps`
 * read. Nothing here opens a conversation.
 */
function applyStructuredSessionVerdicts(
  projected: ReturnType<typeof projectOrchestrationFleet>['workers'],
  durable: ReadonlyMap<string, FleetDurableWorker>,
  host: {
    db: OrchestrationDb
    now: number
    statuses: Parameters<typeof projectOrchestrationFleet>[0]['statuses']
  }
): void {
  const activityByPane = new Map(
    host.statuses.map((evidence) => [evidence.activity.paneKey, evidence.activity.state])
  )
  for (const worker of projected) {
    const handle = durable.get(worker.dispatchId)?.agentTerminalHandle
    const observed = handle ? observeStructuredAssigneeSession(handle, host.db) : null
    if (!observed) {
      continue
    }
    const { sessionId, observation } = observed
    const activity = sessionId
      ? activityByPane.get(
          structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId)
        )
      : undefined
    applyExecutionHostVerdict(
      worker,
      { ...observation, ...(activity ? { activity } : {}) },
      host.now,
      durable
    )
  }
}

/** A row's structured session and its verdict; a refusal to resolve it is unverifiable, not fatal. */
function observeStructuredAssigneeSession(
  handle: string,
  db: OrchestrationDb
): { sessionId: string | null; observation: StructuredWorkerObservation } | null {
  try {
    const assignee = resolveStructuredAssignee(handle, db)
    return assignee
      ? {
          sessionId: assignee.sessionId,
          observation: observeResolvedStructuredAssignee(assignee, db)
        }
      : null
  } catch (error) {
    return {
      sessionId: null,
      observation: {
        status: 'unverifiable',
        reason: error instanceof Error ? error.message : String(error)
      }
    }
  }
}

/**
 * The same fleet verdict `worker-list` publishes, for one Dispatch.
 *
 * Why worker-show needs it: `observation.status` is PTY liveness, so an agent that died
 * at a trust prompt inside a live pane read `live` here and `unverifiable` from
 * `worker-list` — and `worker-list`'s own `nextAction` pointed back at this command.
 */
export async function projectFleetWorkerPage(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string
): Promise<Awaited<ReturnType<typeof projectWorkerFleet>> | null> {
  const rows = db.listWorkerTerminalResources({ dispatchIds: [dispatchId], limit: 1 })
  if (rows.length === 0) {
    return null
  }
  const now = Date.now()
  await ensureSessionHostForStructuredRows(runtime, rows)
  return projectWorkerFleet({
    db,
    rows,
    attentionFacts: db.getWorkerAttentionFactsForDispatches([dispatchId], now),
    statuses: runtime.getOrchestrationFleetAgentStatusSnapshot(),
    limit: 1,
    now
  })
}

export async function projectFleetWorker(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string
): Promise<OrchestrationFleetWorker | null> {
  return (await projectFleetWorkerPage(runtime, db, dispatchId))?.workers[0] ?? null
}
