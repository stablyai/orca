import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { WorkerTerminalResourceRow } from '../../../../orchestration/worker-terminal-ownership'

export function workerTerminalLeaseIsCurrent(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string,
  resource: WorkerTerminalResourceRow
): boolean {
  const worker = db.getWorkerDispatch(dispatchId)
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
