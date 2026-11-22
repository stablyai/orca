// A coordinator that will never read for its Runs again (a bot Chat replaced by /new or by an agent
// change, a deleted chat, or a terminal that ended with nothing left in its pane) stops coordinating
// them: its Runs are unbound in one write, so their open worker asks are told now and a later ask
// finds no coordinator and is told at once. `run-use` still binds them to a new coordinator.
import type { OrchestrationDb } from '../orchestration-db'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { OrchestrationCoordinatorKey } from '../../addressing/orchestration-caller-identity'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'
import { isOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address'

function retireCoordinatorRuns(
  db: OrchestrationDb,
  coordinator: OrchestrationCoordinatorKey
): void {
  runLifecycleWriteTransaction(db.db, 'retire_coordinator_runs', () => {
    db.unbindOtherRunsForCoordinator(coordinator, '')
  })
}

export function retireCoordinatorChatRuns(db: OrchestrationDb, sessionId: string): void {
  if (isOrcaSessionId(sessionId)) {
    retireCoordinatorRuns(db, { orcaSessionId: sessionId, paneKey: null, terminalHandle: null })
  }
}

/** The Runs coordinated from a pane whose terminal ended with no successor in that pane. */
export function retireCoordinatorPaneRuns(db: OrchestrationDb, paneKey: string): void {
  // Read first: most terminals coordinate nothing, and their exit needn't take the write lock.
  if (db.runsBoundToPane(paneKey).length === 0) {
    return
  }
  retireCoordinatorRuns(db, { orcaSessionId: null, paneKey, terminalHandle: null })
}

/** A replaced or deleted chat; the replacement or delete stands even when its Runs can't be retired. */
export function retireChatRuns(
  runtime: Pick<OrcaRuntimeService, 'getOrchestrationDb'>,
  sessionId: string | null | undefined
): void {
  if (!sessionId) {
    return
  }
  try {
    retireCoordinatorChatRuns(runtime.getOrchestrationDb(), sessionId)
  } catch (error) {
    console.warn('[orchestration] could not retire a closed chat from its Runs', error)
  }
}
