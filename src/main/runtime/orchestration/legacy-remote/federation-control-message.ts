import { MESSAGE_TYPES, type MessagePriority, type MessageType } from '../db/orchestration-records'
import { BOT_ITEM_MAIL_SENDER } from '../../../../shared/bots/bot-item-note-runs'
import { callerMailProvenance } from '../db/messages/message-orca-provenance'
import type { OrchestrationDb } from '../db/orchestration-db'
import { OrchestrationError } from '../orchestration-error'

const MESSAGE_TYPE_SET = new Set<MessageType>(MESSAGE_TYPES)

export type FederatedControlMessage = {
  from: string
  subject: string
  body: string
  type: MessageType
  priority: MessagePriority
  threadId: string | null
  payload: string | null
}

export function encodeFederatedControlMessage(message: FederatedControlMessage): string {
  return JSON.stringify(message)
}

export function parseFederatedControlMessage(payload: string): FederatedControlMessage {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    throw new OrchestrationError('invalid_argument', 'Federated control message is invalid JSON.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OrchestrationError('invalid_argument', 'Federated control message is invalid.')
  }
  const message = parsed as Partial<FederatedControlMessage>
  if (
    typeof message.from !== 'string' ||
    typeof message.subject !== 'string' ||
    typeof message.body !== 'string' ||
    typeof message.type !== 'string' ||
    !MESSAGE_TYPE_SET.has(message.type as MessageType)
  ) {
    throw new OrchestrationError('invalid_argument', 'Federated control message is incomplete.')
  }
  return {
    from: message.from,
    subject: message.subject,
    body: message.body,
    type: message.type as MessageType,
    priority:
      message.priority === 'high' || message.priority === 'urgent' ? message.priority : 'normal',
    threadId: typeof message.threadId === 'string' ? message.threadId : null,
    payload: typeof message.payload === 'string' ? message.payload : null
  }
}

export function importFederatedControlMessage(
  db: OrchestrationDb,
  params: {
    dispatchId: string
    messageId: string
    payload: string
  }
): { imported: boolean; type: MessageType } {
  const attachment = db.getRemoteDispatchAttachment(params.dispatchId)
  if (!attachment) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Remote Dispatch ${params.dispatchId} was not found.`
    )
  }
  db.requireRun(attachment.home_run_id)
  const parsed = parseFederatedControlMessage(params.payload)
  // An older home may have queued the reserved sender; refusing it here would stall the relay behind it.
  const message = parsed.from === BOT_ITEM_MAIL_SENDER ? { ...parsed, from: 'unknown' } : parsed
  const recipient = `dispatch:${params.dispatchId}`
  const existing = db.getMessageById(params.messageId)
  if (existing) {
    // A replay is compared with what the first import stored, after insert dropped any claimed provenance.
    const stored =
      message.payload == null
        ? message.payload
        : (callerMailProvenance({ from: message.from, payload: message.payload }) ?? null)
    if (
      existing.run_id !== attachment.home_run_id ||
      existing.to_handle !== recipient ||
      existing.from_handle !== message.from ||
      existing.subject !== message.subject ||
      existing.body !== message.body ||
      existing.type !== message.type ||
      existing.priority !== message.priority ||
      existing.thread_id !== message.threadId ||
      existing.payload !== stored
    ) {
      throw new OrchestrationError(
        'request_mismatch',
        `Federated control message ${params.messageId} conflicts with an existing message.`
      )
    }
    return { imported: false, type: message.type }
  }
  db.insertMessage({
    id: params.messageId,
    runId: attachment.home_run_id,
    from: message.from,
    to: recipient,
    subject: message.subject,
    body: message.body,
    type: message.type,
    priority: message.priority,
    threadId: message.threadId ?? undefined,
    payload: message.payload ?? undefined
  })
  return { imported: true, type: message.type }
}
