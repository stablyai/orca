import type {
  FleetDurableWorker,
  OrchestrationFleetWorker
} from '../../../../../../shared/orchestration/fleet/orchestration-fleet-projection'
import type { OrchestrationSessionWorkerState } from '../../../../../../shared/orchestration-session-workers'

/** A recorded stop or end outranks liveness; contact loss reads as unverifiable, never as an exit. */
export function sessionWorkerState(
  worker: Pick<OrchestrationFleetWorker, 'outcome' | 'liveness' | 'host'>,
  durable: Pick<FleetDurableWorker, 'workerState' | 'agentTerminalHandle'>
): OrchestrationSessionWorkerState {
  if (durable.workerState === 'stopped' || durable.workerState === 'abandoned') {
    return 'stopped'
  }
  if (worker.outcome === 'succeeded') {
    return 'completed'
  }
  // A local start cut before it bound a terminal or chat never handed over its brief, so no worker
  // runs; a paired server's may still be running it.
  const neverBound =
    durable.workerState === 'start_unknown' &&
    !durable.agentTerminalHandle &&
    worker.host.kind === 'local'
  if (worker.outcome === 'failed' || neverBound) {
    return 'failed'
  }
  if (worker.liveness.verdict === 'exited') {
    return 'stopped'
  }
  return worker.liveness.verdict === 'unverifiable' ? 'unverifiable' : 'working'
}
