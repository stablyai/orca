/**
 * An execution host's own observation of a worker, applied to its fleet row. The fleet projection
 * reads agent-status rows, which a worker with no pane never has; the host that runs the worker is
 * the better evidence whenever it answers, whether it is a remote server or this runtime's own
 * structured-session host.
 */

import {
  refreshOrchestrationFleetLivenessAttention,
  type FleetDurableWorker,
  type OrchestrationFleetPage
} from '../../../../../../shared/orchestration-fleet-projection'
import { projectFleetNextAction } from '../../../../../../shared/orchestration-fleet-worker-projection'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { AgentStatusState } from '../../../../../../shared/agent-status-types'
import { isStructuredSessionAddress } from '../../../../structured-worker-identity'

export type ExecutionHostObservation = {
  status: 'live' | 'unverifiable' | 'exited'
  reason?: string
  /** What a live agent is doing, when the host that runs it can say. */
  activity?: AgentStatusState
}

type FleetWorkerRow = OrchestrationFleetPage['workers'][number]

export function applyExecutionHostVerdict(
  worker: FleetWorkerRow,
  observation: ExecutionHostObservation,
  observedAt: number,
  durable: ReadonlyMap<string, FleetDurableWorker>
): void {
  if (worker.liveness.verdict === 'exited' && observation.status !== 'exited') {
    return
  }
  worker.liveness =
    observation.status === 'live'
      ? { verdict: 'live', observedAt, source: 'execution_host' }
      : observation.status === 'exited'
        ? { verdict: 'exited', source: 'execution_host' }
        : { verdict: 'unverifiable', reason: hostReportedReason(observation.reason) }
  if (observation.status === 'live' && observation.activity) {
    worker.stage.activity = observation.activity
  }
  worker.evidence.liveStatus = observation.status === 'live' ? 'fresh' : 'unavailable'
  worker.evidence.lastObservedAt = observation.status === 'unverifiable' ? null : observedAt
  refreshFleetWorkerVerdict(worker, durable)
}

// Recompute every projection derived from the host's verdict.
export function refreshFleetWorkerVerdict(
  worker: FleetWorkerRow,
  durable: ReadonlyMap<string, FleetDurableWorker>
): void {
  refreshOrchestrationFleetLivenessAttention(worker)
  const row = durable.get(worker.dispatchId)
  if (row) {
    worker.nextAction = projectFleetNextAction(row, worker.liveness)
  }
}

type HostReportedReason =
  | 'missing_status'
  | 'stale_status'
  | 'future_status'
  | 'restored_unconfirmed'

const HOST_REPORTED_REASONS: readonly HostReportedReason[] = [
  'missing_status',
  'stale_status',
  'future_status',
  'restored_unconfirmed'
]

/** The host answered; contact was never lost, so never relabel its verdict as host_unavailable. */
function hostReportedReason(reason: string | undefined): HostReportedReason | 'host_indeterminate' {
  return HOST_REPORTED_REASONS.find((known) => known === reason) ?? 'host_indeterminate'
}

/** The session host answers for structured rows, and after a restart nothing has installed it. */
export async function ensureSessionHostForStructuredRows(
  runtime: Pick<OrcaRuntimeService, 'ensureStructuredAgentSessionHost'>,
  rows: readonly { agentTerminalHandle: string | null }[]
): Promise<void> {
  if (rows.some((row) => isStructuredSessionAddress(row.agentTerminalHandle))) {
    await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
  }
}
