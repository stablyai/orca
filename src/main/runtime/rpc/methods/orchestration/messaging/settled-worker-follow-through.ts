import { parseOrcaSessionAddress } from '../../../../../../shared/orca-session-address'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import {
  clearFollowUpMail,
  markUnreadFollowUpMail,
  restoreFollowUpMail,
  FOLLOW_UP_MESSAGE_TYPES,
  listDispatchesWithFollowUpMail
} from '../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import type { OrchestrationSessionCaller } from '../../../../orchestration/orchestration-caller-identity'
import { resolveOrcaSessionParty } from '../../../../orchestration/orchestration-party'
import { readStructuredAgentSessionRecord } from '../../../../structured-worker-authority'
import { createHash } from 'node:crypto'
import { escalateWorkerFailure } from '../../../../orchestration/worker-failure-escalation'
import { dispatchReportMailbox } from '../../../../orchestration/dispatch-report-mailbox'
import {
  planWorkerFollowUp,
  startWorkerFollowUp,
  type WorkerFollowUpOutcome
} from './worker-follow-up'
import { captureReportedWorkerResumeSession } from '../worker/worker-resume-session-capture'
import { reportedWorkerOutcome } from '../worker/worker-start-receipt'

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
  void continueUnreadMail(runtime, db, dispatchId).catch((error: unknown) => {
    console.warn('[orchestration] unread worker mail was not continued', dispatchId, error)
  })
}

async function continueUnreadMail(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string
): Promise<void> {
  const unread = db.getUnreadMessages(`dispatch:${dispatchId}`, [...FOLLOW_UP_MESSAGE_TYPES])
  const first = unread[0]
  if (!first) {
    clearFollowUpMail(db, dispatchId)
    return
  }
  let outcome: WorkerFollowUpOutcome | undefined
  try {
    const plan = planWorkerFollowUp(db, dispatchId, first.type)
    outcome =
      plan?.kind === 'start'
        ? await startWorkerFollowUp({
            ctx: { runtime, orchestrationCaller: senderSession(db, first.from_handle) },
            db,
            plan,
            from: first.from_handle,
            message: {
              subject:
                unread.length === 1
                  ? first.subject
                  : `${first.subject} (+${unread.length - 1} more)`,
              body:
                unread.length === 1
                  ? first.body || first.subject
                  : unread
                      .map((message) => `${message.subject}\n${message.body}`.trim())
                      .join('\n\n')
            },
            consumesMessageIds: unread.map((message) => message.id)
          })
        : plan
  } catch (error) {
    // The mail stays unread and marked, so the next start, report replay or send retries it.
    noticeUnreadMailNotContinued(
      runtime,
      db,
      dispatchId,
      error instanceof Error ? error.message : String(error)
    )
    return
  }
  const startedId = outcome?.kind === 'started' ? outcome.receipt.dispatchId : undefined
  const followUpId = outcome?.kind === 'steer' ? outcome.dispatchId : startedId
  if (typeof followUpId !== 'string') {
    return
  }
  if (outcome?.kind === 'started' && custodyOf(db, followUpId) === 'failed') {
    // What it took goes back with the rest of the worker's held mail.
    restoreFollowUpMail(
      db,
      unread.map((message) => message.id)
    )
    // A report replayed while it started may have cleared the marker the restored mail needs.
    markUnreadFollowUpMail(db, dispatchId)
  }
  passHeldWorkerMail(runtime, db, followUpId)
}

/** Whether a follow-up took over its worker: ready or already reported, failed, or still starting. */
function custodyOf(
  db: OrchestrationDb,
  dispatchId: string
): 'ready' | 'reported' | 'starting' | 'failed' {
  const worker = db.getWorkerDispatch(dispatchId)
  if (reportedWorkerOutcome(worker)) {
    return 'reported'
  }
  return worker?.state === 'ready' || worker?.state === 'starting' ? worker.state : 'failed'
}

/** Mail held anywhere in a worker's lineage follows its newest follow-up: delivered once that one is ready or
 *  has reported, kept unread on it with one notice when its start failed (so the next send takes it). */
export function passHeldWorkerMail(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  followUpId: string
): void {
  const custody = custodyOf(db, followUpId)
  if (custody === 'starting') {
    return
  }
  const worker = db.getWorkerDispatch(followUpId)
  const seen = new Set([followUpId])
  let source = db.getDispatchContextById(followUpId)?.follow_up_of_dispatch_id
  for (
    ;
    source && !seen.has(source);
    source = db.getDispatchContextById(source)?.follow_up_of_dispatch_id
  ) {
    seen.add(source)
    const first = db.getDispatchContextById(source)?.follow_up_mail_at
      ? db.getUnreadMessages(`dispatch:${source}`, [...FOLLOW_UP_MESSAGE_TYPES])[0]
      : undefined
    if (first) {
      if (custody === 'failed') {
        const reason = worker?.last_error ?? worker?.state ?? 'unknown'
        noticeUnreadMailNotContinued(runtime, db, source, reason)
      }
      let page
      do {
        page = db.routeUnreadDirectMessagesToDispatchMailbox(
          followUpId,
          first.run_id,
          `dispatch:${source}`
        )
        for (const type of custody === 'failed' ? [] : page.types) {
          runtime.notifyMessageArrived(`dispatch:${followUpId}`, type)
        }
      } while (page.hasMore)
    }
    clearFollowUpMail(db, source)
  }
  if (custody !== 'ready') {
    // A follow-up that already finished holds this mail as any finished worker does.
    markUnreadFollowUpMail(db, followUpId)
  }
  if (custody === 'reported') {
    continueUnreadWorkerMail(runtime, db, followUpId)
  }
}

/** Nothing is lost silently: the coordinator hears that its mail did not reach the worker, once per batch. */
function noticeUnreadMailNotContinued(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string,
  reason: string
): void {
  const dispatch = db.getDispatchContextById(dispatchId)
  if (!dispatch) {
    return
  }
  escalateWorkerFailure(
    db,
    dispatch,
    {
      id: `msg_followup_${createHash('sha256')
        .update(JSON.stringify([dispatchId, dispatch.follow_up_mail_at]))
        .digest('hex')
        .slice(0, 24)}`,
      from: `dispatch:${dispatchId}`,
      mailbox: () => dispatchReportMailbox(db, dispatch),
      describe: (task) => ({
        subject: 'Mail did not reach the finished worker',
        body: `Orca could not continue the worker of ${task} with the mail it had not read before reporting: ${reason}. The mail is kept; send to dispatch:${dispatchId} again to retry.`
      }),
      payload: { dispatchId, reason }
    },
    (handle, type) => runtime.notifyMessageArrived(handle, type)
  )
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
    // A database closed before this ran (shutdown, tests) has nothing left to continue.
    console.warn('[orchestration] restored worker mail was not scanned', error)
  }
}

function senderSession(db: OrchestrationDb, from: string): OrchestrationSessionCaller | undefined {
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
