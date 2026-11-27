import type { OrchestrationDb } from '../../db/orchestration-db'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../../../shared/agent-session/identity/orca-session-address'
import { canonicalOrcaSessionId } from '../../addressing/session-lineage/canonical-orca-session-id'
import { readWorkerPresence } from '../../db/worker-presence/worker-presence-store'
import { observeWorker } from './worker-presence-report'
import { START_BLOCKED_FENCE } from './awaiting-worker-start-report'
import { WORKER_AGENT_STARTING_STAGE } from '../../db/worker-dispatch/worker-awaiting-agent-stage'
import { RETAINED_CHAT_BEFORE_BRIEF_STAGE } from '../../db/worker-dispatch/restart-cut-worker-start'
import { SUBMIT_WITHHELD_STAGE, type UnconfirmedStartEvidence } from './unconfirmed-start-evidence'
import { confirmUnknownWorkerStart } from './worker-working-observation'
import type { WorkerTurnStopReportDeps } from './worker-turn-stop-report'

/** One fence per Dispatch: a start is unconfirmed once, whichever runtime sees it. */
const START_UNCONFIRMED_FENCE = 'start-unconfirmed'

/** One fence per Dispatch for a resume's withheld continue prompt, apart from its start's. */
const RESTART_CONTINUE_WITHHELD_FENCE = 'restart-continue-withheld'

/** Stages from which the worker may hold the brief: delivery began, or its turn went unseen. */
const BRIEF_HANDED_OVER_STAGES: ReadonlySet<string> = new Set([
  'dispatch_input',
  'turn_observation',
  'turn_start_unobserved',
  SUBMIT_WITHHELD_STAGE,
  // Reported only from the restart pass: a live slow start sends no alert.
  WORKER_AGENT_STARTING_STAGE
])

export type UnconfirmedWorkerStart =
  | {
      surface: 'terminal'
      /** The terminal's last lines, when they could be read. */ screen?: string
      /** How the brief went in and what followed; see describeUnconfirmedStartEvidence. */
      evidence?: UnconfirmedStartEvidence
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
  const worker = db.getWorkerDispatch(dispatchId)
  const chat = dispatch?.assignee_orca_session_id
  const from =
    chat && isOrcaSessionId(chat)
      ? formatOrcaSessionAddress(canonicalOrcaSessionId(chat))
      : dispatch?.assignee_handle
  // An older binary could have handed over a chat brief without recording dispatch_input.
  const attachedChat =
    start.surface === 'chat' &&
    (worker?.stage === 'authority_attached' || worker?.stage === RETAINED_CHAT_BEFORE_BRIEF_STAGE)
  if (
    !dispatch ||
    !from ||
    (dispatch.status !== 'pending' && dispatch.status !== 'dispatched') ||
    worker?.state !== 'start_unknown' ||
    !(attachedChat || BRIEF_HANDED_OVER_STAGES.has(worker.stage)) ||
    db.getFederatedDispatch(dispatchId)
  ) {
    return
  }
  const seen = readWorkerPresence(db, dispatchId)
  // Any presence but this alert's own was reported as its own news; a working or resting worker
  // also proves its turn ran, and an alert is never sent twice.
  // A start-blocked prompt was seen before the brief went in, so it proves no turn ran.
  if (seen && seen.fence !== START_UNCONFIRMED_FENCE && seen.fence !== START_BLOCKED_FENCE) {
    if (seen.presence !== 'gone') {
      confirmUnknownWorkerStart(db, dispatchId)
    }
    return
  }
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
        lastOutput: start.surface === 'terminal' ? start.screen : undefined,
        ...(start.surface === 'terminal' && start.evidence ? { startEvidence: start.evidence } : {})
      }
    },
    deps
  )
}

/** A resumed terminal worker whose continue prompt Orca left unsent is told to its coordinator
 *  once, with the same advice as a start's; a turn seen later supersedes it. */
export function observeWithheldRestartContinue(
  db: OrchestrationDb,
  dispatchId: string,
  continued: { screen?: string; evidence: UnconfirmedStartEvidence },
  deps: WorkerTurnStopReportDeps
): void {
  const dispatch = db.getDispatchContextById(dispatchId)
  const from = dispatch?.assignee_handle
  if (
    !dispatch ||
    !from ||
    (dispatch.status !== 'pending' && dispatch.status !== 'dispatched') ||
    db.getFederatedDispatch(dispatchId)
  ) {
    return
  }
  observeWorker(
    db,
    { kind: 'local', dispatch },
    {
      presence: 'at-rest',
      fence: RESTART_CONTINUE_WITHHELD_FENCE,
      legacyStopKey: RESTART_CONTINUE_WITHHELD_FENCE,
      rest: {
        from,
        reason: 'start-unconfirmed',
        startSurface: 'terminal',
        lastOutput: continued.screen,
        startEvidence: continued.evidence
      }
    },
    deps
  )
}
