import { parseOrcaSessionAddress } from '../../../../../shared/agent-session/identity/orca-session-address'
import type { OrchestrationDb } from '../../db/orchestration-db'
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

/** That id, only for an outcome whose sender a local coordinator would take as its worker: Orca
 *  writing as the Dispatch, or its bound worker. Any other sender keeps its ordinary report id. */
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
  const session = parseOrcaSessionAddress(stop.from)
  const sentAsWorker =
    stop.from === `dispatch:${target.dispatch.id}` ||
    (dispatch?.assignee_handle != null && stop.from === dispatch.assignee_handle) ||
    (session !== null && session === dispatch?.assignee_orca_session_id)
  return sentAsWorker ? startOutcomeReportId(target.dispatch.id) : undefined
}
