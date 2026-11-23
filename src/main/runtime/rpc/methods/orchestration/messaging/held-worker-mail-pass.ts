import { createHash } from 'node:crypto'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import {
  clearFollowUpMail,
  markUnreadFollowUpMail
} from '../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import { FOLLOW_UP_MESSAGE_TYPES } from '../../../../orchestration/db/dispatch-context/worker-follow-up-plan'
import { listUnreadTargetedMessageIds } from '../../../../orchestration/db/messages/message-work-target-provenance'
import { dispatchReportMailbox } from '../../../../orchestration/workers/reports/dispatch-report-mailbox'
import { escalateWorkerFailure } from '../../../../orchestration/workers/reports/worker-failure-escalation'
import {
  notifyTargetedMailHeld,
  preserveUnreadFollowUpMail
} from '../../../../orchestration/workers/reports/work-target-mail-hold-notice'
import {
  partitionUnreadMessagesForWorkerDispatch,
  verifyUnreadMailboxMessagesForWorkerDispatch
} from '../../../../../bots/bot-work-target-unread-provenance'
import { reportedWorkerOutcome } from '../worker/start/worker-start-receipt'
import { afterWorkerStartWait } from '../worker/start/readiness/worker-start-waits'

const inFlightPassByDb = new WeakMap<OrchestrationDb, Map<string, Promise<void>>>()

/** Whether a follow-up took over its worker: ready or already reported, failed, or still starting. */
export function custodyOf(
  db: OrchestrationDb,
  dispatchId: string
): 'ready' | 'reported' | 'starting' | 'failed' {
  const worker = db.getWorkerDispatch(dispatchId)
  if (reportedWorkerOutcome(worker)) {
    return 'reported'
  }
  return worker?.state === 'ready' || worker?.state === 'starting' ? worker.state : 'failed'
}

/** Nothing is lost silently: the coordinator hears that its mail did not reach the worker, once per batch. */
export function noticeUnreadMailNotContinued(
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
        body: `Orca could not continue the worker of ${task} with the mail it had not read before reporting: ${reason}. The mail is kept for your next send to dispatch:${dispatchId}.`
      }),
      payload: { dispatchId, reason }
    },
    (handle, type) => runtime.notifyMessageArrived(handle, type)
  )
}

/** Mail held anywhere in a worker's lineage follows its newest follow-up only after verifying any stored work-target provenance against the live destination worker. */
export function passHeldWorkerMail(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  followUpId: string,
  onReportedFollowUp: (dispatchId: string) => void
): Promise<void> {
  let map = inFlightPassByDb.get(db)
  if (!map) {
    map = new Map()
    inFlightPassByDb.set(db, map)
  }
  const previous = map.get(followUpId) ?? Promise.resolve()
  const run = previous
    .catch(() => undefined)
    .then(() => runPassHeldWorkerMail(runtime, db, followUpId, onReportedFollowUp))
  const tracked = run.finally(() => {
    if (map.get(followUpId) === tracked) {
      map.delete(followUpId)
    }
  })
  map.set(followUpId, tracked)
  return tracked
}

async function runPassHeldWorkerMail(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  followUpId: string,
  onReportedFollowUp: (dispatchId: string) => void
): Promise<void> {
  const seen = new Set([followUpId])
  for (
    let source = db.getDispatchContextById(followUpId)?.follow_up_of_dispatch_id;
    source && !seen.has(source);
    source = db.getDispatchContextById(source)?.follow_up_of_dispatch_id
  ) {
    seen.add(source)
  }
  const lineageMailboxes = [...seen].map((id) => `dispatch:${id}`)
  const initialCustody = custodyOf(db, followUpId)
  if (initialCustody === 'starting') {
    runtime.withdrawStaleChatMail(lineageMailboxes)
    // A start still waiting on its agent settles later, in the background: re-verify and pass mail then.
    afterWorkerStartWait(followUpId, 'held-mail', () =>
      passHeldWorkerMail(runtime, db, followUpId, onReportedFollowUp)
    )
    return
  }

  // If takesMailOf moved targeted mail onto followUpId before startup finished and checkout drifted meanwhile, return failed messages to parent.
  const followUpDispatch = db.getDispatchContextById(followUpId)
  const parentId = followUpDispatch?.follow_up_of_dispatch_id
  if (followUpDispatch && parentId) {
    const ownTargetedIds = listUnreadTargetedMessageIds(db, `dispatch:${followUpId}`, {
      runId: followUpDispatch.run_id
    })
    if (ownTargetedIds.length > 0) {
      const ownPartition = await partitionUnreadMessagesForWorkerDispatch(
        runtime,
        db,
        followUpId,
        ownTargetedIds.map((id) => ({ id }))
      )
      if (ownPartition.held.length > 0) {
        const returnIds = ownPartition.held.map((item) => item.messageId)
        let page
        do {
          page = db.routeUnreadDirectMessagesToDispatchMailbox(
            parentId,
            followUpDispatch.run_id,
            `dispatch:${followUpId}`,
            undefined,
            true,
            { onlyMessageIds: returnIds }
          )
        } while (page.hasMore)
        preserveUnreadFollowUpMail(db, parentId)
        notifyTargetedMailHeld((handle, type) => runtime.notifyMessageArrived(handle, type), db, {
          dispatchId: parentId,
          heldMessageIds: returnIds,
          reason: ownPartition.held[0]!.reason
        })
      }
    }
  }

  for (const source of [...seen].slice(1)) {
    const sourceDispatch = db.getDispatchContextById(source)
    const first = sourceDispatch?.follow_up_mail_at
      ? db.getUnreadMessages(`dispatch:${source}`, [...FOLLOW_UP_MESSAGE_TYPES])[0]
      : undefined
    if (first) {
      const partition = await verifyUnreadMailboxMessagesForWorkerDispatch(runtime, db, {
        destinationDispatchId: followUpId,
        sourceMailbox: `dispatch:${source}`,
        runId: first.run_id
      })
      const currentCustody = custodyOf(db, followUpId)
      if (currentCustody === 'starting') {
        runtime.withdrawStaleChatMail(lineageMailboxes)
        afterWorkerStartWait(followUpId, 'held-mail', () =>
          passHeldWorkerMail(runtime, db, followUpId, onReportedFollowUp)
        )
        return
      }
      if (partition.deliverableIds.length > 0) {
        if (currentCustody === 'failed') {
          const worker = db.getWorkerDispatch(followUpId)
          const reason = worker?.last_error ?? worker?.state ?? 'unknown'
          noticeUnreadMailNotContinued(runtime, db, source, reason)
        }
        let page
        do {
          page = db.routeUnreadDirectMessagesToDispatchMailbox(
            followUpId,
            first.run_id,
            `dispatch:${source}`,
            undefined,
            true,
            { onlyMessageIds: partition.deliverableIds }
          )
          for (const type of currentCustody === 'failed' ? [] : page.types) {
            runtime.notifyMessageArrived(`dispatch:${followUpId}`, type)
          }
        } while (page.hasMore)
      }
      if (partition.held.length > 0) {
        preserveUnreadFollowUpMail(db, source)
        notifyTargetedMailHeld((handle, type) => runtime.notifyMessageArrived(handle, type), db, {
          dispatchId: source,
          heldMessageIds: partition.held.map((item) => item.messageId),
          reason: partition.held[0]!.reason
        })
      }
    }
    if (db.getUnreadMessages(`dispatch:${source}`, [...FOLLOW_UP_MESSAGE_TYPES]).length === 0) {
      clearFollowUpMail(db, source)
    }
  }

  const finalCustody = custodyOf(db, followUpId)
  if (finalCustody === 'ready') {
    clearFollowUpMail(db, followUpId)
  } else {
    markUnreadFollowUpMail(db, followUpId)
  }
  runtime.withdrawStaleChatMail(lineageMailboxes)
  if (finalCustody === 'ready') {
    runtime.deliverPendingMessagesForHandle(`dispatch:${followUpId}`)
  }
  if (finalCustody === 'reported') {
    onReportedFollowUp(followUpId)
  }
}
