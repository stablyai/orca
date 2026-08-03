import type { OrcaRuntimeService } from '../orca-runtime'
import { completeWorkerTerminalRelease } from '../rpc/methods/orchestration-worker-release-completion'

export type WorkerTerminalReleaseReconciliationResult = {
  attempted: number
  released: number
  pending: number
  unknown: number
  retained: number
}

// Finishes ONLY previously requested releases after startup/reconnect terminal discovery.
// It never invents release intent: resources outside requested/releasing are untouched, and
// unresolved identity defers (release_pending) rather than settling or broadening the close.
export async function reconcileRequestedWorkerTerminalReleases(
  runtime: OrcaRuntimeService
): Promise<WorkerTerminalReleaseReconciliationResult> {
  const db = runtime.getOrchestrationDb()
  const backlog = db.listWorkerTerminalReleaseBacklog()
  const result: WorkerTerminalReleaseReconciliationResult = {
    attempted: backlog.length,
    released: 0,
    pending: 0,
    unknown: 0,
    retained: 0
  }
  for (const resource of backlog) {
    try {
      const receipt = await completeWorkerTerminalRelease({
        runtime,
        db,
        dispatchId: resource.owner_dispatch_id,
        resource,
        mode: 'recovery'
      })
      if (receipt.state === 'released' || receipt.state === 'already_released') {
        result.released += 1
      } else if (receipt.state === 'release_pending') {
        result.pending += 1
      } else if (receipt.state === 'release_unknown') {
        result.unknown += 1
      } else {
        result.retained += 1
      }
    } catch {
      // Archive or endpoint failure: durable intent stays requested; a later discovery retries.
      result.pending += 1
    }
  }
  if (result.attempted > 0) {
    // Structured counts only; never transcript content or paths.
    console.info('[orchestration] worker terminal release reconciliation', result)
  }
  return result
}
