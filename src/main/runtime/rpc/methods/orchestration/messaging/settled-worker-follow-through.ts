import { parseOrcaSessionAddress } from '../../../../../../shared/orca-session-address'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import {
  clearFollowUpMail,
  FOLLOW_UP_MESSAGE_TYPES,
  listDispatchesWithFollowUpMail
} from '../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import type { OrchestrationSessionCaller } from '../../../../orchestration/orchestration-caller-identity'
import { resolveOrcaSessionParty } from '../../../../orchestration/orchestration-party'
import { readStructuredAgentSessionRecord } from '../../../../structured-worker-authority'
import { planWorkerFollowUp, startWorkerFollowUp } from './worker-follow-up'
import { captureReportedWorkerResumeSession } from '../worker/worker-resume-session-capture'

/** After a report settles (or replays): save the worker's conversation, then continue mail it never read. */
export function followThroughWorkerReport(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string
): void {
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
  const plan = first && planWorkerFollowUp(db, dispatchId, first.type)
  let steerTo = plan?.kind === 'steer' ? plan.dispatchId : undefined
  if (first && plan?.kind === 'start') {
    const outcome = await startWorkerFollowUp({
      ctx: { runtime, orchestrationCaller: senderSession(db, first.from_handle) },
      db,
      plan,
      from: first.from_handle,
      message: {
        subject:
          unread.length === 1 ? first.subject : `${first.subject} (+${unread.length - 1} more)`,
        body: unread.map((message) => message.body || message.subject).join('\n\n')
      },
      consumesMessageIds: unread.map((message) => message.id)
    }).catch((error: unknown) => {
      // A refused follow-up leaves the mail where it was, unread, as before this existed.
      console.warn('[orchestration] unread mail did not become a follow-up', dispatchId, error)
      return undefined
    })
    // Mail that arrived while it started still reaches a follow-up that started.
    const started = outcome?.kind === 'started' && outcome.receipt.state === 'ready'
    const startedId = started ? outcome.receipt.dispatchId : undefined
    steerTo =
      outcome?.kind === 'steer'
        ? outcome.dispatchId
        : typeof startedId === 'string'
          ? startedId
          : undefined
  }
  if (first && steerTo) {
    moveUnreadMail(runtime, db, first.run_id, dispatchId, steerTo)
  }
  clearFollowUpMail(db, dispatchId)
}

/** Moved mail is delivered like any Dispatch mail: a wake for each type that arrived. */
function moveUnreadMail(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  runId: string,
  from: string,
  to: string
): void {
  let page
  do {
    page = db.routeUnreadDirectMessagesToDispatchMailbox(to, runId, `dispatch:${from}`)
    for (const type of page.types) {
      runtime.notifyMessageArrived(`dispatch:${to}`, type)
    }
  } while (page.hasMore)
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
