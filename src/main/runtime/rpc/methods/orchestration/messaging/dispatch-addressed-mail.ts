import type { OrchestrationDb } from '../../../../orchestration/db'
import type { MessageType } from '../../../../orchestration/types'
import { assertDispatchMailboxDeliverable } from './recipient-routing'
import { passHeldWorkerMail } from './settled-worker-follow-through'
import { planWorkerFollowUp, startWorkerFollowUp, type FollowUpContext } from './worker-follow-up'

/** Mail to `dispatch:<id>`, sent or replied: a finished worker takes it as its next Task, a working one
 *  (or the follow-up already continuing it) as mail in the returned Dispatch's mailbox. */
export async function routeDispatchAddressedMail(args: {
  ctx: FollowUpContext
  db: OrchestrationDb
  dispatchId: string
  type: MessageType
  from: string
  message: { subject: string; body?: string | undefined }
}): Promise<
  { kind: 'started'; receipt: Record<string, unknown> } | { kind: 'mail'; dispatchId: string }
> {
  const { ctx, db } = args
  const plan = planWorkerFollowUp(db, args.dispatchId, args.type)
  // Only a settled worker awaits; mail to a working one stays synchronous until it is inserted.
  const followUp =
    plan?.kind === 'start'
      ? await startWorkerFollowUp({
          ctx,
          db,
          plan,
          from: args.from,
          message: args.message
        })
      : plan
  if (followUp?.kind === 'started') {
    if (typeof followUp.receipt.dispatchId === 'string') {
      passHeldWorkerMail(ctx.runtime, db, followUp.receipt.dispatchId)
    }
    return followUp
  }
  const dispatchId = followUp?.dispatchId ?? args.dispatchId
  assertDispatchMailboxDeliverable(ctx.runtime, db, dispatchId)
  return { kind: 'mail', dispatchId }
}
