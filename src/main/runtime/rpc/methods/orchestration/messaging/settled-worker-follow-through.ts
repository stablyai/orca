import { parseOrcaSessionAddress } from '../../../../../../shared/agent-session/identity/orca-session-address'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import {
  clearFollowUpMail,
  markUnreadFollowUpMail,
  getFollowUpDispatch,
  hasNewUnreadFollowUpMail,
  listDispatchesWithFollowUpMail,
  receivesMailWhole
} from '../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import { FOLLOW_UP_MESSAGE_TYPES } from '../../../../orchestration/db/dispatch-context/worker-follow-up-plan'
import { listUnreadTargetedMessageIds } from '../../../../orchestration/db/messages/message-work-target-provenance'
import {
  peerCoordinatorAddress,
  peerCoordinatorCaller,
  type OrchestrationEntryCaller
} from '../../../../orchestration/addressing/orchestration-caller-identity'
import { resolveOrcaSessionParty } from '../../../../orchestration/addressing/orchestration-party'
import { readStructuredAgentSessionRecord } from '../../../../orchestration/terminal-authority/structured-sessions/structured-worker-authority'
import {
  beginUnreadFollowThrough,
  endUnreadFollowThrough,
  notifyTargetedMailHeld,
  preserveUnreadFollowUpMail
} from '../../../../orchestration/workers/reports/work-target-mail-hold-notice'
import {
  planWorkerFollowUp,
  startWorkerFollowUp,
  type WorkerFollowUpOutcome
} from './worker-follow-up'
import { verifyUnreadFollowThroughBeforeAction } from '../../../../../bots/bot-work-target-unread-provenance'
import { captureReportedWorkerResumeSession } from '../worker/follow-up/worker-resume-session-capture'
import {
  custodyOf,
  noticeUnreadMailNotContinued,
  passHeldWorkerMail as passHeldWorkerMailWithContinue
} from './held-worker-mail-pass'

/** After a report settles (or replays): save the worker's conversation, then continue mail it never read. */
export function followThroughWorkerReport(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string | undefined
): void {
  if (!dispatchId) {
    return
  }
  captureReportedWorkerResumeSession(runtime, db, dispatchId)
  continueUnreadWorkerMail(runtime, db, dispatchId)
}

/** Mail the worker never read before it reported is not lost: it goes to the worker's newer Dispatch,
 *  or becomes one, as a send after the report would. Its report marked it, so a restart resumes this. */
export function continueUnreadWorkerMail(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string
): void {
  void continueUnreadWorkerMailNow(runtime, db, dispatchId).catch((error: unknown) => {
    console.warn('[orchestration] unread worker mail was not continued', dispatchId, error)
  })
}

export function passHeldWorkerMail(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  followUpId: string
): Promise<void> {
  return passHeldWorkerMailWithContinue(runtime, db, followUpId, (id) =>
    continueUnreadWorkerMail(runtime, db, id)
  )
}

// The Task only points at the mail, which the follow-up's mailbox holds however much there is.
const FOLLOW_UP_TASK = {
  subject: 'New messages',
  body: 'You have new orchestration messages. Read them with the `check` command above, then continue.'
}

// A chat is handed each message whole right after this Task, one at a time.
const CHAT_FOLLOW_UP_TASK = {
  subject: 'New messages',
  body: 'You have new orchestration messages. They arrive next, one at a time; act on each.'
}

/** Awaitable unread-mail follow-through for callers and restart-recovery verification. */
export async function continueUnreadWorkerMailNow(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string
): Promise<void> {
  const first = db.getUnreadMessages(`dispatch:${dispatchId}`, [...FOLLOW_UP_MESSAGE_TYPES])[0]
  if (!first) {
    clearFollowUpMail(db, dispatchId)
    return
  }
  const worker = db.getWorkerDispatch(dispatchId)
  if (worker?.state === 'stopped') {
    // Orca does not restart a stopped worker on its own; the next send carries its mail.
    return
  }
  if (
    worker?.state === 'starting' &&
    worker.runtime_epoch &&
    worker.runtime_epoch !== runtime.getRuntimeId()
  ) {
    if (worker.agent_terminal_handle) {
      noticeUnreadMailNotContinued(
        runtime,
        db,
        dispatchId,
        'Orca restarted while its follow-up was starting'
      )
      return
    }
    db.failWorkerStart(dispatchId, worker.stage, 'Orca restarted before this follow-up started.')
  }
  if (custodyOf(db, dispatchId) === 'reported' && !hasNewUnreadFollowUpMail(db, dispatchId)) {
    noticeUnreadMailNotContinued(
      runtime,
      db,
      dispatchId,
      'its follow-up reported without reading the mail it was started for'
    )
    return
  }
  beginUnreadFollowThrough(db, dispatchId)
  let plan: ReturnType<typeof planWorkerFollowUp> = undefined
  let outcome: WorkerFollowUpOutcome | undefined
  try {
    try {
      plan = planWorkerFollowUp(db, dispatchId, first.type)
      const steerId = plan?.kind === 'steer' ? plan.dispatchId : undefined
      await verifyUnreadFollowThroughBeforeAction(runtime, db, dispatchId, steerId)
      outcome =
        plan?.kind === 'start'
          ? await startWorkerFollowUp({
              ctx: { runtime, orchestrationCaller: senderCaller(db, first) },
              db,
              plan,
              from: first.from_handle,
              message: receivesMailWhole(plan.latest.assignee_handle)
                ? CHAT_FOLLOW_UP_TASK
                : FOLLOW_UP_TASK,
              takesMailOf: dispatchId,
              trustedUnreadMailFollowThrough: true
            })
          : plan
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const heldTargetedIds = listUnreadTargetedMessageIds(db, `dispatch:${dispatchId}`)
      if (heldTargetedIds.length > 0) {
        preserveUnreadFollowUpMail(db, dispatchId)
        notifyTargetedMailHeld((handle, type) => runtime.notifyMessageArrived(handle, type), db, {
          dispatchId,
          heldMessageIds: heldTargetedIds,
          reason
        })
      } else {
        noticeUnreadMailNotContinued(runtime, db, dispatchId, reason)
      }
      const claimed = plan?.kind === 'start' ? getFollowUpDispatch(db, plan.latest.id) : undefined
      if (claimed) {
        markUnreadFollowUpMail(db, claimed.id)
      }
      return
    }
    const startedId = outcome?.kind === 'started' ? outcome.receipt.dispatchId : undefined
    const followUpId = outcome?.kind === 'steer' ? outcome.dispatchId : startedId
    if (typeof followUpId !== 'string') {
      return
    }
    if (outcome?.kind === 'started' && custodyOf(db, followUpId) === 'failed') {
      const followUpWorker = db.getWorkerDispatch(followUpId)
      const reason = followUpWorker?.last_error ?? followUpWorker?.state ?? 'unknown'
      const heldTargetedIds = listUnreadTargetedMessageIds(db, `dispatch:${dispatchId}`)
      if (heldTargetedIds.length > 0) {
        preserveUnreadFollowUpMail(db, dispatchId)
        notifyTargetedMailHeld((handle, type) => runtime.notifyMessageArrived(handle, type), db, {
          dispatchId,
          heldMessageIds: heldTargetedIds,
          reason
        })
      } else {
        noticeUnreadMailNotContinued(runtime, db, dispatchId, reason)
      }
    }
    await passHeldWorkerMail(runtime, db, followUpId)
  } finally {
    endUnreadFollowThrough(db, dispatchId)
  }
}

/** The Dispatch a worker_done receipt settled. */
export function settledDispatchId(receipt: unknown): string | undefined {
  if (!receipt || typeof receipt !== 'object' || !('lifecycle' in receipt)) {
    return undefined
  }
  const { lifecycle } = receipt
  return lifecycle &&
    typeof lifecycle === 'object' &&
    'dispatchId' in lifecycle &&
    typeof lifecycle.dispatchId === 'string'
    ? lifecycle.dispatchId
    : undefined
}

/** After the open returns, so continuing a worker can use the database it is opening. */
export function continueRestoredWorkerMailSoon(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  isCurrent: () => boolean
): void {
  setTimeout(() => {
    if (isCurrent()) {
      continueAllUnreadWorkerMail(runtime, db)
    }
  }, 0).unref?.()
}

/** At startup: continue what a restart interrupted between a report and its follow-up. */
export function continueAllUnreadWorkerMail(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb
): void {
  try {
    for (const dispatchId of listDispatchesWithFollowUpMail(db)) {
      continueUnreadWorkerMail(runtime, db, dispatchId)
    }
  } catch (error) {
    console.warn('[orchestration] restored worker mail was not scanned', error)
  }
}

/** The sender continues as itself: a session as its session, a paired Orca as the coordinator of its Run. */
function senderCaller(
  db: OrchestrationDb,
  message: { from_handle: string; run_id: string }
): OrchestrationEntryCaller | undefined {
  const peerRun = db.getPeerRun(message.run_id)
  if (peerRun && message.from_handle === peerCoordinatorAddress(peerRun.conversation_id)) {
    return peerCoordinatorCaller(peerRun)
  }
  const from = message.from_handle
  const sessionId = parseOrcaSessionAddress(from)
  const record = sessionId ? readStructuredAgentSessionRecord(sessionId) : null
  return sessionId && record
    ? {
        ...resolveOrcaSessionParty(sessionId, db),
        sessionId,
        workspaceId: record.location.workspaceId
      }
    : undefined
}
