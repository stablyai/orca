import type { OrchestrationDb } from '../../db/orchestration-db'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../../../shared/agent-session/identity/orca-session-address'
import { canonicalOrcaSessionId } from '../../addressing/session-lineage/canonical-orca-session-id'
import { observeWorker } from './worker-presence-report'
import type { WorkerTurnStopReportDeps } from './worker-turn-stop-report'

/** One fence per Dispatch: a start is unconfirmed once, whichever runtime sees it. */
const START_UNCONFIRMED_FENCE = 'start-unconfirmed'

export type UnconfirmedWorkerStart =
  | {
      surface: 'terminal'
      /** The terminal's last lines, when they could be read. */ screen?: string
    }
  | { surface: 'chat' }

/** A start Orca could not see begin is told to its coordinator once; a turn seen later supersedes it. */
export function observeUnconfirmedWorkerStart(
  db: OrchestrationDb,
  dispatchId: string,
  start: UnconfirmedWorkerStart,
  deps: WorkerTurnStopReportDeps
): void {
  const dispatch = db.getDispatchContextById(dispatchId)
  if (
    !dispatch ||
    (dispatch.status !== 'pending' && dispatch.status !== 'dispatched') ||
    db.getWorkerDispatch(dispatchId)?.state !== 'start_unknown'
  ) {
    return
  }
  const chat = dispatch.assignee_orca_session_id
  const from =
    chat && isOrcaSessionId(chat)
      ? formatOrcaSessionAddress(canonicalOrcaSessionId(chat))
      : (dispatch.assignee_handle ?? `dispatch:${dispatchId}`)
  observeWorker(
    db,
    { kind: 'local', dispatch },
    {
      presence: 'at-rest',
      fence: START_UNCONFIRMED_FENCE,
      legacyStopKey: START_UNCONFIRMED_FENCE,
      rest: {
        from,
        reason: 'start-unconfirmed',
        startSurface: start.surface,
        lastOutput: start.surface === 'terminal' ? start.screen : undefined
      }
    },
    deps
  )
}
