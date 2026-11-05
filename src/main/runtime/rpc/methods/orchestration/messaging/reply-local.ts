import type { OrchestrationDb } from '../../../../orchestration/db'
import type { MessageRow } from '../../../../orchestration/types'
import { exposeMessage } from './mailbox-message-receipt'
import { recordReceiptBeforeNudge } from './mutation-replay-nudge'
import { resolveReplyRecipient, resolveRunBoundDispatchRecipient } from './recipient-routing'
import { routeDispatchAddressedMail } from './dispatch-addressed-mail'
import type { FollowUpContext } from './worker-follow-up'

/** A reply to its sender, routed as a send to that sender would be, so a finished worker is continued. */
export async function replyToMessage(args: {
  ctx: FollowUpContext
  db: OrchestrationDb
  original: MessageRow
  params: { body: string; from?: string }
  recordMutationReceipt: ((receipt: unknown) => void) | undefined
}): Promise<unknown> {
  const { ctx, db, original, params } = args
  const { runtime } = ctx
  let { to, runId } = resolveReplyRecipient({
    runtime,
    db,
    originalFrom: original.from_handle,
    originalRunId: original.run_id
  })
  const from = params.from ?? original.to_handle
  const subject = `Re: ${original.subject}`
  const dispatchId = to.startsWith('dispatch:') ? to.slice('dispatch:'.length) : undefined
  // Federation owns its own recipient and liveness checks.
  if (dispatchId && !db.getFederatedDispatch(dispatchId)) {
    const routed = await routeDispatchAddressedMail({
      ctx,
      db,
      dispatchId,
      type: 'status',
      from,
      message: { subject, body: params.body }
    })
    if (routed.kind === 'started') {
      db.markAsRead([original.id])
      return routed.receipt
    }
    const runBound = resolveRunBoundDispatchRecipient(runtime, db, routed.dispatchId)
    to = runBound?.to ?? `dispatch:${routed.dispatchId}`
    runId = runBound?.runId ?? runId
  }
  db.markAsRead([original.id])
  const reply = db.insertMessage({
    from,
    to,
    subject,
    body: params.body,
    threadId: original.thread_id ?? original.id,
    runId
  })
  return recordReceiptBeforeNudge(
    args.recordMutationReceipt,
    { message: exposeMessage(reply) },
    () => runtime.notifyMessageArrived(reply.to_handle, reply.type)
  )
}
