import type { OrchestrationDb } from '../../orchestration/db'
import type { WorkerTerminalResourceRow } from '../../orchestration/worker-terminal-ownership'
import type { OrcaRuntimeService } from '../../orca-runtime'

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
