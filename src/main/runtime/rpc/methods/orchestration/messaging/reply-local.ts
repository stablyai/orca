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
  const fields = {
    from: params.from ?? original.to_handle,
    subject: `Re: ${original.subject}`,
    body: params.body,
    threadId: original.thread_id ?? original.id
  }
  const dispatchId = to.startsWith('dispatch:') ? to.slice('dispatch:'.length) : undefined
  // Federation owns its own recipient and liveness checks.
  if (dispatchId && !db.getFederatedDispatch(dispatchId)) {
    const route = routeDispatchAddressedMail({
      ctx,
      db,
      dispatchId,
      type: 'status',
      from: fields.from,
      message: fields
    })
    const routed = route.kind === 'start' ? route.finish(await route.start()) : route
    if (routed.kind === 'started') {
      db.markAsRead([original.id])
      const followUp = routed.receipt.dispatchId
      // The follow-up's Task carries the reply; a read copy keeps the thread and the receipt's message id.
      const taken = db.insertMessage({
        ...fields,
        to: typeof followUp === 'string' ? `dispatch:${followUp}` : to,
        runId
      })
      db.markAsRead([taken.id])
      return { ...routed.receipt, message: exposeMessage(taken) }
    }
    const runBound = resolveRunBoundDispatchRecipient(runtime, db, routed.dispatchId)
    to = runBound?.to ?? `dispatch:${routed.dispatchId}`
    runId = runBound?.runId ?? runId
  }
  db.markAsRead([original.id])
  const reply = db.insertMessage({ ...fields, to, runId })
  return recordReceiptBeforeNudge(
    args.recordMutationReceipt,
    { message: exposeMessage(reply) },
    () => runtime.notifyMessageArrived(reply.to_handle, reply.type)
  )
}
