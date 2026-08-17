import type { RoomDelivery, RoomEvent, RoomParticipant } from '../../../shared/rooms'
import type { RoomAttachmentManager } from './attachments'
import type { RoomDatabase } from './database'
import { stageRoomDeliveryAttachments } from './delivery-attachments'
import type { RoomDeliveryConfirmations } from './delivery-confirmations'
import { assertCurrentRoomDelivery, isRoomDeliveryMissing } from './delivery-current-guard'
import { formatRoomDeliveryPrompt } from './delivery-prompt'
import { deferPausedDelivery, deliveryFailureState } from './delivery-selection'
import type { RoomHarnessAdapter } from './harness-adapter'
import { roomParticipantHarnessBinding } from './participant-harness-binding'

export async function deliverRoomDelivery(input: {
  db: RoomDatabase
  adapters: Record<string, RoomHarnessAdapter>
  attachments: RoomAttachmentManager
  confirmations: RoomDeliveryConfirmations
  emit: (roomId: string, event: RoomEvent) => void
  ensureParticipantReady: (participantId: string) => Promise<RoomParticipant>
  delivery: RoomDelivery
  steer: boolean
  moveRejectedSteerToHead: boolean
  disposed: () => boolean
}): Promise<void> {
  let { delivery } = input
  const message = input.db.messages.get(delivery.messageId)
  let target = input.db.participants.get(delivery.participantId)
  input.emit(message.roomId, { type: 'delivery.updated', delivery })
  try {
    input.db.core.get(message.roomId)
    const initiallyDeferred = deferPausedDelivery(input.db, delivery)
    if (initiallyDeferred) {
      return input.emit(target.roomId, {
        type: 'delivery.updated',
        delivery: initiallyDeferred
      })
    }
    // A second status probe would reject silent daemon-recovered PTYs.
    if (!input.steer) {
      target = await input.ensureParticipantReady(target.id)
    }
    assertCurrentRoomDelivery(input.db, delivery)
    const adapter = target.agent ? input.adapters[target.agent] : undefined
    const binding = roomParticipantHarnessBinding(target)
    if (!adapter || !binding) {
      throw new Error('room_agent_not_attached')
    }
    const snapshot = input.db.snapshot(message.roomId)
    const role = snapshot.roles.find((item) => item.id === target.roleId) ?? null
    const configuration = input.db.deliveryConfiguration.pending({
      participant: target,
      room: snapshot.room,
      role
    })
    const replyParent = message.replyToId ? input.db.messages.get(message.replyToId) : null
    const attachmentPaths = await stageRoomDeliveryAttachments({
      adapter,
      binding,
      attachments: input.attachments,
      messages: replyParent ? [replyParent, message] : [message]
    })
    assertCurrentRoomDelivery(input.db, delivery)
    const prompt = formatRoomDeliveryPrompt({
      deliveryId: delivery.id,
      attempt: delivery.attempts,
      response: message.mentions.some(
        (identity) => identity.toLocaleLowerCase() === target.identity.toLocaleLowerCase()
      )
        ? 'required'
        : 'optional',
      roomName: snapshot.room.name,
      message,
      replyParent,
      target,
      participants: snapshot.participants,
      configuration: configuration.configuration,
      attachmentPaths
    })
    const imagePaths = message.attachments
      .filter((attachment) => attachment.mimeType.startsWith('image/'))
      .map((attachment) => attachmentPaths.get(attachment.id)!)
    target = input.db.participants.get(delivery.participantId)
    const deferred = deferPausedDelivery(input.db, delivery)
    if (deferred) {
      return input.emit(target.roomId, { type: 'delivery.updated', delivery: deferred })
    }
    input.confirmations.prepare(delivery.id, target.id, configuration.snapshot)
    delivery = input.db.messages.deliveries.setPhase(delivery.id, 'submitting')
    input.emit(message.roomId, { type: 'delivery.updated', delivery })
    const result = input.steer
      ? await adapter.steer!(binding, prompt, imagePaths.length > 0 ? { imagePaths } : undefined)
      : await adapter.send(binding, prompt, {
          beforeWrite: () => assertCurrentRoomDelivery(input.db, delivery),
          clearInput: delivery.attempts > 1,
          ...(imagePaths.length > 0 ? { imagePaths } : {})
        })
    if (!result.accepted) {
      throw new Error(result.refusedReason ?? 'room_delivery_refused')
    }
    if (input.db.messages.deliveries.get(delivery.id).state !== 'delivering') {
      return
    }
    delivery = input.db.messages.deliveries.setPhase(delivery.id, 'awaiting-turn')
    input.emit(message.roomId, { type: 'delivery.updated', delivery })
    // Only a provider turn confirms PTY paste; a swallowed paste must be requeued.
    input.confirmations.arm(delivery.id)
  } catch (error) {
    input.confirmations.discard(delivery.id)
    if (input.disposed() || isRoomDeliveryMissing(input.db, delivery.id)) {
      return
    }
    const messageText = error instanceof Error ? error.message : String(error)
    const uncertain = messageText === 'conversation_steer_uncertain'
    if (input.steer && !uncertain) {
      const queued = input.db.messages.deliveries.returnSteerToNext(
        delivery.id,
        messageText,
        Date.now(),
        input.moveRejectedSteerToHead
      )
      input.emit(message.roomId, { type: 'delivery.updated', delivery: queued })
      throw new Error(messageText)
    }
    const exhausted = delivery.attempts >= 5
    const delay = Math.min(60_000, 1000 * 2 ** Math.max(0, delivery.attempts - 1))
    const failed = input.db.messages.deliveries.complete(
      delivery.id,
      uncertain ? 'failed' : deliveryFailureState(exhausted),
      uncertain ? 'room_delivery_uncertain' : messageText,
      uncertain || exhausted ? Number.MAX_SAFE_INTEGER : Date.now() + delay
    )
    input.emit(message.roomId, { type: 'delivery.updated', delivery: failed })
  }
}
