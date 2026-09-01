import type { Store } from '../persistence'
import type {
  AutomationDispatchResult,
  AutomationRun,
  AutomationRunPersistInput
} from '../../shared/automations-types'

/** Why: the renderer retires a run's owned terminal only AFTER the run settles,
 *  then sends a follow-up update whose sole content is null terminal pointers.
 *  Discarding it would leave "View run" targeting a dead terminal, so a final
 *  run still accepts pointer CLEARING — never a new status/result/usage. */
export function clearFinalRunTerminalPointers(
  store: Pick<Store, 'updateAutomationRun'>,
  current: AutomationRun,
  result: AutomationDispatchResult
): AutomationRun {
  const cleanup: AutomationRunPersistInput = {
    runId: current.id,
    status: current.status,
    workspaceId: current.workspaceId,
    error: current.error
  }
  let clearsPointer = false
  if (result.terminalSessionId === null && current.terminalSessionId !== null) {
    cleanup.terminalSessionId = null
    clearsPointer = true
  }
  if (result.terminalPaneKey === null && current.terminalPaneKey !== null) {
    cleanup.terminalPaneKey = null
    clearsPointer = true
  }
  if (result.terminalPtyId === null && current.terminalPtyId !== null) {
    cleanup.terminalPtyId = null
    clearsPointer = true
  }
  if (!clearsPointer) {
    return current
  }
  return store.updateAutomationRun(cleanup)
}
