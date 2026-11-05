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

/** Mail to `dispatch:<id>`, sent or replied: a finished worker takes it as its next Task, a working one
 *  (or the follow-up already continuing it) as mail in the returned Dispatch's mailbox. Mail is decided
 *  synchronously, so nothing can settle a working worker before the caller inserts it: after a start, the
 *  caller's own continuation runs `finish` and inserts in the same turn. */
export function routeDispatchAddressedMail(args: {
  ctx: FollowUpContext
  db: OrchestrationDb
  dispatchId: string
  type: MessageType
  from: string
  message: { subject: string; body?: string | undefined }
}):
  | Routed
  | {
      kind: 'start'
      start: () => Promise<WorkerFollowUpOutcome>
      finish: (outcome: WorkerFollowUpOutcome) => Routed
    } {
  const { ctx, db } = args
  const plan = planWorkerFollowUp(db, args.dispatchId, args.type)
  if (plan?.kind !== 'start') {
    return mailTo(ctx, db, plan?.dispatchId ?? args.dispatchId)
  }
  return {
    kind: 'start',
    start: () => startWorkerFollowUp({ ctx, db, plan, from: args.from, message: args.message }),
    finish: (followUp) => {
      if (followUp.kind === 'steer') {
        return mailTo(ctx, db, followUp.dispatchId)
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
