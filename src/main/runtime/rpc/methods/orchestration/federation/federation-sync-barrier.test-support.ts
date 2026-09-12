import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'

// A run-wide sync coalesces onto whatever relay tick is already in flight, and that tick may have
// read the peer before the test's latest mutation existed. Chain past the current round instead so
// awaiting the barrier really means "everything enqueued before this call has been exchanged".
export async function syncFederationBarrier(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb
): Promise<void> {
  const dispatches = db.listActiveFederatedDispatches()
  await Promise.allSettled(
    dispatches.map((dispatch) =>
      runtime.syncOrchestrationFederatedDispatchAfterCurrent(dispatch.dispatch_id)
    )
  )
}
