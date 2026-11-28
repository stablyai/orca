import type { OrchestrationDb } from '../../db/orchestration-db'
import { sendsAsDispatchWorker } from '../../mailbox/senders/agent-message-relation'
import { senderParty } from '../../mailbox/senders/agent-message-sender'
import {
  stopReportId,
  type WorkerTurnStop,
  type WorkerTurnStopDispatch
} from './worker-turn-stop-report'

/** The one id Orca writes a start's outcome (it failed, or never became ready) under, wherever the
 *  worker runs: a paired Orca's import keeps it, so its Run home knows the report is Orca's own. */
export function startOutcomeReportId(dispatchId: string): string {
  return stopReportId(dispatchId, 'start-outcome')
}

/** That id, only for an outcome this Orca's own delivery would take as the Dispatch's worker's, by
 *  the same check: so the Run home, which cannot see the worker, admits exactly what local would. */
export function startOutcomeReportIdFor(
  db: OrchestrationDb,
  target: WorkerTurnStopDispatch,
  stop: Pick<WorkerTurnStop, 'reason' | 'from'>
): string | undefined {
  if (
    target.kind !== 'local' ||
    (stop.reason !== 'start-failed' && stop.reason !== 'never-ready')
  ) {
    return undefined
  }
  const dispatch = db.getDispatchContextById(target.dispatch.id)
  // Start outcomes are always escalations, the type delivery judges them as.
  return dispatch && sendsAsDispatchWorker(db, dispatch, senderParty(stop.from, db), 'escalation')
    ? startOutcomeReportId(dispatch.id)
    : undefined
}
