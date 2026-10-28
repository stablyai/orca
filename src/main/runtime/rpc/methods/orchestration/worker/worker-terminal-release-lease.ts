import type { WorkerTerminalReleaseRuntime } from '../../../../orchestration/worker-terminal-release-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { WorkerTerminalResourceRow } from '../../../../orchestration/worker-terminal-ownership'
import type { WorkerDispatchRow } from '../../../../orchestration/types'
import { resolveStructuredWorkerIdentity } from '../../../../structured-worker-authority'
import { isStructuredWorkerHandle } from '../../../../../../shared/structured-worker-handle'

export function workerTerminalLeaseIsCurrent(
  runtime: WorkerTerminalReleaseRuntime,
  db: OrchestrationDb,
  dispatchId: string,
  resource: WorkerTerminalResourceRow,
  // Probe the live reminted handle; compare durable worker/resource handles only for stored identity.
  liveTerminalHandle: string
): boolean {
  const worker = db.getWorkerDispatch(dispatchId)
  if (isStructuredWorkerHandle(resource.terminal_handle)) {
    return structuredWorkerTerminalLeaseIsCurrent(db, dispatchId, worker, resource)
  }
  const authority = runtime.getOrchestrationDispatchAuthority(liveTerminalHandle)
  // Exited PTYs keep identity/host evidence but cannot mint launch authority.
  return Boolean(
    worker?.agent_terminal_handle === resource.terminal_handle &&
    (authority
      ? resource.host_scope === JSON.stringify(authority.hostScope)
      : runtime.getTerminalLivenessVerdict(liveTerminalHandle)?.status === 'exited') &&
    db.isDispatchProcessCurrent({
      dispatchId,
      paneKey: runtime.getTerminalPaneKey(liveTerminalHandle),
      processIncarnation: runtime.getTerminalProcessIncarnation(liveTerminalHandle)
    }) &&
    !db.workerTerminalResourceHasIdentityConflict(resource.id)
  )
}

/** Check durable pane/lineage identity independently of child liveness.
 * Requiring installed session records after restart would falsely retain requested releases as identity_unproven. */
function structuredWorkerTerminalLeaseIsCurrent(
  db: OrchestrationDb,
  dispatchId: string,
  worker: WorkerDispatchRow | undefined,
  resource: WorkerTerminalResourceRow
): boolean {
  const identity = resolveStructuredWorkerIdentity(resource.terminal_handle, db)
  return Boolean(
    worker?.agent_terminal_handle === resource.terminal_handle &&
    identity &&
    resource.host_scope === JSON.stringify(identity.hostScope) &&
    db.isDispatchProcessCurrent({
      dispatchId,
      paneKey: identity.paneKey,
      processIncarnation: identity.processIncarnation
    }) &&
    !db.workerTerminalResourceHasIdentityConflict(resource.id)
  )
}
