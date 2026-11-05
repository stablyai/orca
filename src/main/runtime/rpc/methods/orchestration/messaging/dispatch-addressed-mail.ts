import type { OrchestrationDb } from '../../../../orchestration/db'
import type { MessageType } from '../../../../orchestration/types'
import { assertDispatchMailboxDeliverable } from './recipient-routing'
import { passHeldWorkerMail } from './settled-worker-follow-through'
import {
  planWorkerFollowUp,
  startWorkerFollowUp,
  type FollowUpContext,
  type WorkerFollowUpOutcome
} from './worker-follow-up'

type Routed =
  | { kind: 'started'; receipt: Record<string, unknown> }
  | { kind: 'mail'; dispatchId: string }
  | {
      kind: 'start'
      start: () => Promise<WorkerFollowUpOutcome>
      finish: (outcome: WorkerFollowUpOutcome) => Routed
    }

type RouteArgs = {
  ctx: FollowUpContext
  db: OrchestrationDb
  dispatchId: string
  type: MessageType
  from: string
  message: { subject: string; body?: string | undefined }
}

/** Mail to `dispatch:<id>`, sent or replied: a finished worker takes it as its next Task, a working one
 *  (or the follow-up already continuing it) as mail in the returned Dispatch's mailbox. Mail is decided
 *  synchronously, so nothing can settle a working worker before the caller inserts it. Callers loop
 *  `while (routed.kind === 'start') routed = routed.finish(await routed.start())` inline, so the final
 *  decision and the insert share one turn. */
export function routeDispatchAddressedMail(args: RouteArgs): Routed {
  const { ctx, db } = args
  const plan = planWorkerFollowUp(db, args.dispatchId, args.type)
  if (plan?.kind !== 'start') {
    return mailTo(ctx, db, plan?.dispatchId ?? args.dispatchId)
  }
  return {
    kind: 'start',
    start: () => startWorkerFollowUp({ ctx, db, plan, from: args.from, message: args.message }),
    // A follow-up another message claimed is routed afresh: as mail if it works, continued if it already finished.
    finish: (followUp) => {
      if (followUp.kind === 'steer') {
        return routeDispatchAddressedMail({ ...args, dispatchId: followUp.dispatchId })
      }
      if (typeof followUp.receipt.dispatchId === 'string') {
        passHeldWorkerMail(ctx.runtime, db, followUp.receipt.dispatchId)
      }
      return followUp
    }
  }
}

function mailTo(ctx: FollowUpContext, db: OrchestrationDb, dispatchId: string): Routed {
  assertDispatchMailboxDeliverable(ctx.runtime, db, dispatchId)
  return { kind: 'mail', dispatchId }
}
