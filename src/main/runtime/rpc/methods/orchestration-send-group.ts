import type { MessagePriority, MessageType, OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { resolveGroupAddress } from '../../orchestration/groups'
import { resolveBareOrchestrationRecipient } from './orchestration-recipient-routing'
import { legacyWorkerDeliveryContract } from './orchestration-routing'
import type { SendRecipientWarning } from './orchestration-recipient-routing'
import type { SendParams } from './orchestration-schemas'
import type { z } from 'zod'

type SendParamsInput = z.infer<typeof SendParams>
type SendReceipt = <T extends object>(receipt: T) => T & { warnings?: SendRecipientWarning[] }

export async function sendGroupMessage(args: {
  params: SendParamsInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  from: string
  groupAddress: string
  senderPaneKey: string | undefined
  senderRunId: string | undefined
  explicitRunId: string | undefined
  legacyCoordinatorRunId: string | undefined
  revalidateLegacyCoordinator: (() => string) | undefined
  recordMutationReceipt: ((receipt: unknown) => void) | undefined
  withSendWarnings: SendReceipt
}): Promise<unknown> {
  const {
    params,
    runtime,
    db,
    from,
    groupAddress,
    senderPaneKey,
    senderRunId,
    explicitRunId,
    legacyCoordinatorRunId,
    revalidateLegacyCoordinator,
    recordMutationReceipt
  } = args
  // Why: fan out one message per recipient (independent read-tracking) but share a thread_id for correlation (Section 4.5).
  const { terminals } = await runtime.listTerminals(undefined, undefined, {
    includeVisualLayouts: false
  })
  const handles = resolveGroupAddress(groupAddress, from, terminals, (handle: string) =>
    runtime.getAgentStatusForHandle(handle)
  )
  if (handles.length === 0) {
    throw new Error(`No recipients resolved for group address: ${groupAddress}`)
  }

  const legacyAdoptedMailboxOwner = db.getLegacyAdoptedRunMailboxOwner()
  const resolvedRecipients = handles.map((handle) => ({
    handle,
    resolution: resolveBareOrchestrationRecipient({
      runtime,
      db,
      handle,
      senderRunId,
      explicitRunId,
      legacyAdoptedMailboxOwner
    })
  }))
  const deliverableRecipients = resolvedRecipients.filter(
    (
      recipient
    ): recipient is typeof recipient & {
      resolution: { ok: true; to: string; runId?: string; warning?: SendRecipientWarning }
    } => recipient.resolution.ok
  )
  const senderRecipient = resolveBareOrchestrationRecipient({
    runtime,
    db,
    handle: from,
    senderRunId,
    legacyAdoptedMailboxOwner
  })
  const senderMailboxKey = senderRecipient.ok
    ? `${senderRecipient.runId ?? ''}\u0000${senderRecipient.to}`
    : undefined
  const seenMailboxes = new Set<string>()
  const uniqueRecipients = deliverableRecipients.filter(({ resolution }) => {
    const mailboxKey = `${resolution.runId ?? ''}\u0000${resolution.to}`
    if (mailboxKey === senderMailboxKey || seenMailboxes.has(mailboxKey)) {
      return false
    }
    seenMailboxes.add(mailboxKey)
    return true
  })
  if (uniqueRecipients.length === 0) {
    throw new OrchestrationError(
      'terminal_not_found',
      `No recipient of ${groupAddress} resolved to a live terminal or durable Run/Dispatch mailbox.`
    )
  }

  revalidateLegacyCoordinator?.()
  const threadId = params.threadId ?? `thread_${Date.now()}`
  const messages = db.insertMessages(
    uniqueRecipients.map(({ resolution }) => ({
      from,
      to: resolution.to,
      subject: params.subject,
      body: params.body,
      type: params.type as MessageType,
      priority: params.priority as MessagePriority,
      threadId,
      payload: params.payload,
      senderPaneKey,
      runId: resolution.runId,
      deliveryContract: legacyWorkerDeliveryContract(
        runtime,
        resolution.runId ?? legacyCoordinatorRunId,
        resolution.to
      )
    }))
  )
  const groupWarnings = resolvedRecipients.flatMap(({ resolution }) =>
    resolution.ok ? (resolution.warning ? [resolution.warning] : []) : [resolution.warning]
  )
  const receipt = {
    messages,
    recipients: messages.length,
    ...(groupWarnings.length > 0 ? { warnings: groupWarnings } : {})
  }
  recordMutationReceipt?.(receipt)
  for (const message of messages) {
    runtime.notifyMessageArrived(message.to_handle, message.type)
  }
  return receipt
}
