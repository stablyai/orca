// A chat that will never read for its Runs again (a bot Chat replaced by /new or by an agent change,
// or a deleted chat) stops coordinating them: its Runs are unbound in one write, so their open
// worker asks are told now and a later ask finds no coordinator and is told at once.
import type { OrchestrationDb } from '../orchestration-db'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'
import { isOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address'

export function retireCoordinatorChatRuns(db: OrchestrationDb, sessionId: string): void {
  if (!isOrcaSessionId(sessionId)) {
    return
  }
  runLifecycleWriteTransaction(db.db, 'retire_coordinator_chat_runs', () => {
    db.unbindOtherRunsForCoordinator(
      { orcaSessionId: sessionId, paneKey: null, terminalHandle: null },
      ''
    )
  })
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
