import {
  DEFAULT_MESSAGE_DELIVERY_CLASS,
  MESSAGE_DELIVERY_CLASSES,
  MESSAGE_TYPES,
  type MessageDeliveryClass,
  type MessagePriority,
  type MessageType
} from './types'
import type { OrchestrationDb } from './db'
import { OrchestrationError } from './orchestration-error'

const MESSAGE_TYPE_SET = new Set<MessageType>(MESSAGE_TYPES)
const MESSAGE_DELIVERY_CLASS_SET = new Set<string>(MESSAGE_DELIVERY_CLASSES)

export type FederatedControlMessage = {
  from: string
  subject: string
  body: string
  type: MessageType
  priority: MessagePriority
  deliveryClass: MessageDeliveryClass
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
    // Why: a peer that predates the delivery class omits it; 'turn' is the boundary its mail
    // already lands at, so the older side degrades to today's behavior instead of failing.
    deliveryClass: MESSAGE_DELIVERY_CLASS_SET.has(message.deliveryClass as string)
      ? (message.deliveryClass as MessageDeliveryClass)
      : DEFAULT_MESSAGE_DELIVERY_CLASS,
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
  const message = parseFederatedControlMessage(params.payload)
  const recipient = `dispatch:${params.dispatchId}`
  const existing = db.getMessageById(params.messageId)
  if (existing) {
    // Why: delivery_class stays out of this comparison — a relay item first imported by a peer
    // that predates the field stores 'turn', and a re-import after that peer updates would
    // otherwise look like a conflicting message.
    if (
      existing.to_handle !== recipient ||
      existing.from_handle !== message.from ||
      existing.subject !== message.subject ||
      existing.body !== message.body ||
      existing.type !== message.type ||
      existing.priority !== message.priority ||
      existing.thread_id !== message.threadId ||
      existing.payload !== message.payload
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
    from: message.from,
    to: recipient,
    subject: message.subject,
    body: message.body,
    type: message.type,
    priority: message.priority,
    deliveryClass: message.deliveryClass,
    threadId: message.threadId ?? undefined,
    payload: message.payload ?? undefined
  })
  return { imported: true, type: message.type }
}
