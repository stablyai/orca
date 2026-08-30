import type { OrchestrationDb } from '../../orchestration/db'
import type { WorkerTerminalResourceRow } from '../../orchestration/worker-terminal-ownership'
import type { OrcaRuntimeService } from '../../orca-runtime'

/**
 * Whether this dispatch still owns the exact handle, host scope, process incarnation and resource
 * row it leased. Callers re-prove it after every await, because a yield is enough for the handle to
 * be re-bound to a replacement. `terminalWasObservedExited` waives only the host-scope check, which
 * no longer resolves once the process is gone.
 */
export function workerTerminalLeaseIsCurrent(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string,
  resource: WorkerTerminalResourceRow,
  terminalWasObservedExited: boolean
): boolean {
  const worker = db.getWorkerDispatch(dispatchId)
  const authority = runtime.getOrchestrationDispatchAuthority(resource.terminal_handle)
  return Boolean(
    worker?.agent_terminal_handle === resource.terminal_handle &&
    (authority
      ? resource.host_scope === JSON.stringify(authority.hostScope)
      : terminalWasObservedExited) &&
    db.isDispatchProcessCurrent({
      dispatchId,
      paneKey: runtime.getTerminalPaneKey(resource.terminal_handle),
      processIncarnation: runtime.getTerminalProcessIncarnation(resource.terminal_handle)
    }) &&
    !db.workerTerminalResourceHasIdentityConflict(resource.id)
  )
}
