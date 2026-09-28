import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { WorkerTerminalResourceRow } from '../../../../orchestration/worker-terminal-ownership'
import type { WorkerDispatchRow } from '../../../../orchestration/types'
import { resolveStructuredWorkerIdentity } from '../../../../structured-worker-authority'
import { isStructuredWorkerHandle } from '../../../../structured-worker-identity'

export function workerTerminalLeaseIsCurrent(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string,
  resource: WorkerTerminalResourceRow
): boolean {
  const worker = db.getWorkerDispatch(dispatchId)
  if (isStructuredWorkerHandle(resource.terminal_handle)) {
    return structuredWorkerTerminalLeaseIsCurrent(db, dispatchId, worker, resource)
  }
  const authority = runtime.getOrchestrationDispatchAuthority(resource.terminal_handle)
  // Exited PTYs retain identity and host evidence but no longer mint launch authority.
  return Boolean(
    worker?.agent_terminal_handle === resource.terminal_handle &&
    (authority
      ? resource.host_scope === JSON.stringify(authority.hostScope)
      : runtime.getTerminalLivenessVerdict(resource.terminal_handle)?.status === 'exited') &&
    db.isDispatchProcessCurrent({
      dispatchId,
      paneKey: runtime.getTerminalPaneKey(resource.terminal_handle),
      processIncarnation: runtime.getTerminalProcessIncarnation(resource.terminal_handle)
    }) &&
    !db.workerTerminalResourceHasIdentityConflict(resource.id)
  )
}

/**
 * IDENTITY, not liveness. The durable row plus the session-lineage incarnation say whether this is
 * still the same worker; whether its child is alive is what the observation reports, honestly, as
 * live / unverifiable / exited. Asking the record for identity would make a restart — where the
 * host may not be installed yet — read as a different worker, turning a durably requested release
 * into a permanent `retained/identity_unproven`.
 */
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
