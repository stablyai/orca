import type { OrchestrationDb } from '../../orchestration/db'
import { retainedWorkerTerminalReason } from '../../orchestration/db/worker-terminal/worker-terminal-release-identity'
import type { WorkerTerminalResourceRow } from '../../orchestration/worker-terminal-ownership'
import type { WorkerReleaseReceipt } from './orchestration/worker/worker-release-completion'
import { archiveSummary } from './orchestration-worker-terminal-resource-view'

export function identityMismatchReceipt(
  db: OrchestrationDb,
  dispatchId: string,
  resource: WorkerTerminalResourceRow,
  unknownReason: string
): WorkerReleaseReceipt {
  if (resource.release_state === 'unknown') {
    return releaseUnknown(db, dispatchId, resource, unknownReason)
  }
  const retained = db.revertWorkerTerminalReleaseToRetained(resource.id, 'identity_unproven')
  return {
    dispatchId,
    state: 'retained',
    reason: retainedWorkerTerminalReason(retained),
    processAction: 'none',
    archive: archiveSummary(retained)
  }
}

export function releaseUnknown(
  db: OrchestrationDb,
  dispatchId: string,
  resource: WorkerTerminalResourceRow,
  reason: string,
  processAction: WorkerReleaseReceipt['processAction'] = 'none'
): WorkerReleaseReceipt {
  const unknown = db.markWorkerTerminalReleaseUnknown(resource.id, reason)
  return {
    dispatchId,
    state: 'release_unknown',
    processAction,
    archive: archiveSummary(unknown),
    lastError: unknown.release_error ?? reason,
    recovery: `Inspect with: orca orchestration worker-show --dispatch ${dispatchId} --json, then repeat worker-release with the same retry request after exact host evidence is available. Never substitute a broad terminal close.`
  }
}
