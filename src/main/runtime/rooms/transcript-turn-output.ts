import type {
  RoomDelivery,
  RoomEvent,
  RoomMessage,
  RoomParticipant,
  RoomSettledActivity
} from '../../../shared/rooms'
import type { RoomDatabase } from './database'
import { roomDeliveryAttemptsFromTurn } from './delivery-prompt'
import { extractRoomReplyRecipients } from './mentions'
import type { PendingProviderMessage } from './transcript-final-selection'

export function publishRoomTurnOutput(input: {
  db: RoomDatabase
  participant: RoomParticipant
  delivery: RoomDelivery
  providerSessionId: string
  providerMessageId: string
  pending: PendingProviderMessage[]
  candidate: PendingProviderMessage | null
  reply: ReturnType<typeof extractRoomReplyRecipients>
  activity: RoomSettledActivity | null
  timestamp: number
  settleDelivery: boolean
  enqueueDeliveries: boolean
  emit: (roomId: string, event: RoomEvent) => void
  onSettled: (message?: RoomMessage) => void
}): boolean {
  const { db, participant, delivery, reply, activity } = input
  const group = delivery.providerTurnId
    ? db.messages.deliveries.listForTurn(participant.id, delivery.providerTurnId)
    : [delivery]
  const rootMessageId = group[0]?.messageId ?? delivery.messageId
  const messageByDelivery = new Map(group.map((item) => [item.id, item.messageId]))
  let replyToId = rootMessageId
  const history = input.pending.flatMap(({ message }) => {
    const text = message.blocks
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n\n')
    if (message.role === 'user') {
      for (const marker of roomDeliveryAttemptsFromTurn(text)) {
        replyToId = messageByDelivery.get(marker.deliveryId) ?? replyToId
      }
    }
    if (
      message.id === input.candidate?.message.id ||
      message.role !== 'assistant' ||
      message.assistantPhase !== 'final' ||
      message.providerError
    ) {
      return []
    }
    const visible = extractRoomReplyRecipients(text, [], participant.identity)
    return visible.silent ? [] : [{ message, body: visible.body, replyToId }]
  })
  const result = db.transaction(() => {
    const messages: RoomMessage[] = []
    for (const [index, entry] of history.entries()) {
      const saved = db.providerMessages.createReply({
        participant,
        delivery,
        providerSessionId: input.providerSessionId,
        providerMessageId: entry.message.id,
        body: entry.body,
        mentions: [],
        createdAt: entry.message.timestamp ?? input.timestamp,
        replyToId: entry.replyToId,
        retainObserved: true,
        settleDelivery: false,
        enqueueDeliveries: false,
        ...(reply.silent && index === history.length - 1 && activity ? { activity } : {})
      })
      if (saved) {
        messages.push(saved)
      }
    }
    const hasActivity = activity?.messages.some((message) =>
      message.blocks.some(
        (block) =>
          block.type === 'tool-call' ||
          block.type === 'tool-result' ||
          block.type === 'image-ref' ||
          (block.type === 'text' &&
            !extractRoomReplyRecipients(block.text, [], participant.identity).silent)
      )
    )
    let response: RoomMessage | undefined
    if (
      !reply.silent ||
      (history.length === 0 && activity && (hasActivity || activity.state === 'interrupted'))
    ) {
      response =
        db.providerMessages.createReply({
          participant,
          delivery,
          providerSessionId: input.providerSessionId,
          providerMessageId: input.providerMessageId,
          body: reply.body,
          mentions: reply.mentions,
          createdAt: input.candidate?.message.timestamp ?? input.timestamp,
          ...(activity ? { activity } : {}),
          settleDelivery: input.settleDelivery && !reply.silent,
          enqueueDeliveries: input.enqueueDeliveries && !reply.silent,
          ...(reply.silent ? { retainObserved: true, replyToId: rootMessageId } : {})
        }) ?? undefined
      if (response) {
        messages.push(response)
      } else if (!reply.silent) {
        return { messages, response, settled: false, deliveries: [] }
      }
    }
    if (reply.silent) {
      db.providerMessages.ignore(participant.id, input.providerSessionId, input.providerMessageId)
      if (input.settleDelivery) {
        const responseMessageId =
          activity?.state === 'interrupted' ? (response?.id ?? messages.at(-1)?.id ?? null) : null
        if (delivery.providerTurnId) {
          db.messages.deliveries.markRespondedGroup(
            participant.id,
            delivery.providerTurnId,
            responseMessageId,
            input.timestamp
          )
        } else {
          db.messages.deliveries.markResponded(delivery.id, responseMessageId, input.timestamp)
        }
      }
    }
    const deliveries = !input.settleDelivery
      ? []
      : delivery.providerTurnId
        ? db.messages.deliveries.listForTurn(participant.id, delivery.providerTurnId)
        : [db.messages.deliveries.get(delivery.id)]
    return { messages, response, settled: true, deliveries }
  })
  for (const delivery of result.deliveries) {
    input.emit(participant.roomId, { type: 'delivery.updated', delivery })
  }
  for (const message of result.messages) {
    input.emit(participant.roomId, { type: 'message.created', message })
  }
  if (result.settled) {
    input.onSettled(result.response)
  }
  return result.settled
}
