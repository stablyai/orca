import type { MessageType } from '../../../../orchestration/db/orchestration-records'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { formatMessageBanner } from '../../../../orchestration/mailbox/formatting/message-formatting'
import type { CheckMailReconciliation } from './check-mail-reconciliation'
import { withReportFollowUps, exposeMessages } from './mailbox-message-receipt'
import { staleDelivery } from '../../../../orchestration/db/messages/role-mailbox-delivery'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../../../../shared/orchestration/orchestration-rpc-contract'
import type { CheckParams } from '../../../../../../shared/rpc-contract/orchestration/orchestration-params'
import type { z } from 'zod'

type CheckParamsInput = z.infer<typeof CheckParams>

export async function checkDirectMailbox(args: {
  params: CheckParamsInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  handle: string
  typeFilter: MessageType[] | undefined
  signal: AbortSignal | undefined
  reconciliation: CheckMailReconciliation
  revalidateConsumer: () => void
  recordMutationReceipt?: (receipt: unknown) => void
}): Promise<unknown> {
  const { params, runtime, db, handle, typeFilter, signal } = args
  // Direct mail has no Delivery, so any --ack names one outside this mailbox.
  if (params.ack) {
    throw staleDelivery(db, params.ack)
  }
  // Honor legacy unread:false callers for compatibility (design doc §5).
  const showAll = params.all === true || (params.unread === false && params.peek !== true)
  const consumeUnread = !showAll && params.peek !== true
  const readAndReturn = async () => {
    if (consumeUnread) {
      args.revalidateConsumer()
    }
    const messages = showAll
      ? db.getAllMessagesForHandle(handle, undefined, typeFilter)
      : db.getUnreadMessages(handle, typeFilter, { excludeRunOwnedDirect: true })
    if (
      consumeUnread &&
      messages.some((message) => message.run_id === ORCHESTRATION_LEGACY_RUN_ID)
    ) {
      throw new OrchestrationError(
        'legacy_read_only',
        'Legacy orchestration messages are inspect-only; use --peek or --all. No acknowledgment was applied.',
        { effectsApplied: false }
      )
    }
    const respond = (visibleMessages: typeof messages) =>
      withReportFollowUps(db, {
        messages: exposeMessages(visibleMessages),
        count: visibleMessages.length,
        ...(params.format || params.inject
          ? { formatted: visibleMessages.map(formatMessageBanner).join('\n\n') }
          : {})
      })
    return consumeUnread && messages.length
      ? args.reconciliation.takeDirect({
          selected: messages,
          revalidate: args.revalidateConsumer,
          respond,
          record: args.recordMutationReceipt
        })
      : respond(messages)
  }

  if (signal?.aborted) {
    return { messages: [], count: 0 }
  }
  const result = await readAndReturn()
  if (result.count > 0 || !params.wait) {
    return result
  }
  // Abort on socket close to release the long-poll slot immediately (design doc §3.1).
  const waitResult = await runtime.waitForMessage(handle, {
    typeFilter: typeFilter as string[] | undefined,
    timeoutMs: params.timeoutMs ?? undefined,
    signal
  })
  if (signal?.aborted) {
    return { messages: [], count: 0 }
  }
  if (waitResult === 'cancelled') {
    throw new OrchestrationError(
      'consumer_fenced',
      'This direct mailbox became owned by a Run while the check was waiting.'
    )
  }
  return readAndReturn()
}
