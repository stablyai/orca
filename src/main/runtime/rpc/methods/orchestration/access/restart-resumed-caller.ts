import type { OrchestrationCompatibilityEvidence } from '../../../../../../shared/orchestration/orchestration-compatibility-evidence'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { WORKER_RESTART_RESUMED_STAGE } from '../../../../orchestration/db/worker-dispatch/worker-restart-resume'

/**
 * The handle a worker resumed after a restart reports as. Its conversation still names the terminal
 * its brief gave it, which is gone; its own pane names the Dispatch it runs now. Null keeps `from`.
 */
export function restartResumedCallerHandle(
  runtime: Pick<
    OrcaRuntimeService,
    'getLiveTerminalPaneKey' | 'getTerminalHandleForPaneKey' | 'getExistingOrchestrationDb'
  >,
  from: string,
  evidence: OrchestrationCompatibilityEvidence | undefined
): string | null {
  if (!evidence?.paneKey || runtime.getLiveTerminalPaneKey(from) !== null) {
    return null
  }
  const handle = runtime.getTerminalHandleForPaneKey(evidence.paneKey)
  const paneKey = handle ? runtime.getLiveTerminalPaneKey(handle) : null
  const db = runtime.getExistingOrchestrationDb()
  if (!handle || handle === from || !paneKey || !db) {
    return null
  }
  const dispatch = db.getActiveDispatchForIdentity(handle, paneKey)
  return dispatch?.assignee_handle === handle &&
    db.getWorkerDispatch(dispatch.id)?.stage === WORKER_RESTART_RESUMED_STAGE
    ? handle
    : null
}
