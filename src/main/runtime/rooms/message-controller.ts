import type { RoomAttachment, RoomEvent, RoomMessage, RoomUnread } from '../../../shared/rooms'
import type { RoomDatabase } from './database'
import type { RoomAttachmentManager } from './attachments'
import { validateRoomMentions } from './mentions'

export type SendRoomMessageInput = {
  roomId: string
  senderIdentity: string
  body: string
  replyToId?: string | null
  mentions?: string[]
  attachmentUploadIds?: string[]
  targetParticipantIds?: string[]
}

export class RoomMessageController {
  constructor(
    private readonly db: RoomDatabase,
    private readonly attachments: RoomAttachmentManager,
    private readonly emit: (roomId: string, event: RoomEvent) => void,
    private readonly wakeDeliveries: () => void
  ) {}

  async send(input: SendRoomMessageInput): Promise<RoomMessage> {
    if (!input.body.trim() && (input.attachmentUploadIds?.length ?? 0) === 0) {
      throw new Error('room_message_empty')
    }
    this.db.core.get(input.roomId)
    if (input.replyToId) {
      const reply = this.db.messages.get(input.replyToId)
      if (reply.roomId !== input.roomId || reply.deletedAt) {
        throw new Error('room_reply_not_found')
      }
    }
    const participants = this.db.participants.list(input.roomId)
    const sender = this.db.participants.find(input.roomId, input.senderIdentity)
    if (!sender) {
      throw new Error('room_message_sender_invalid')
    }
    const mentions = validateRoomMentions(input.mentions ?? [], participants)
    const attachmentCount = input.attachmentUploadIds?.length ?? 0
    if (attachmentCount > 10) {
      throw new Error('room_attachment_count_exceeded')
    }
    const attachments: RoomAttachment[] = []
    let result
    try {
      attachments.push(
        ...(await this.attachments.consumeUploads(input.roomId, input.attachmentUploadIds ?? []))
      )
      result = this.db.transaction(() => ({
        superseded:
          sender.actorKind === 'user'
            ? this.db.messages.deliveries.supersedeRoomStop(input.roomId)
            : [],
        created: this.db.messages.create({
          roomId: input.roomId,
          senderId: sender.id,
          senderIdentity: sender.identity,
          actorKind: sender.actorKind,
          body: input.body,
          replyToId: input.replyToId,
          mentions,
          attachments,
          targetParticipantIds: input.targetParticipantIds
        })
      }))
    } catch (error) {
      await this.attachments.remove(attachments.map((attachment) => attachment.localPath))
      throw error
    }
    const { created, superseded } = result
    this.emit(input.roomId, { type: 'message.created', message: created.message })
    for (const delivery of superseded) {
      this.emit(input.roomId, { type: 'delivery.updated', delivery })
    }
    for (const delivery of created.deliveries) {
      this.emit(input.roomId, { type: 'delivery.updated', delivery })
    }
    if (superseded.length === 0 && created.deliveries.length === 0) {
      this.emit(input.roomId, { type: 'room.updated', room: this.db.core.get(input.roomId) })
    }
    this.wakeDeliveries()
    return created.message
  }

  update(id: string, senderIdentity: string, body: string): RoomMessage {
    const current = this.db.messages.get(id)
    this.assertUserOwner(current, senderIdentity)
    this.db.messages.deliveries.assertMessageMutable(id)
    const message = this.db.messages.update(id, body)
    this.emit(message.roomId, { type: 'message.updated', message })
    return message
  }

  retarget(id: string, senderIdentity: string, participantIds: readonly string[]): void {
    const current = this.db.messages.get(id)
    this.assertUserOwner(current, senderIdentity)
    const deliveries = this.db.transaction(() =>
      this.db.messages.deliveries.retarget(id, participantIds)
    )
    for (const delivery of deliveries) {
      this.emit(current.roomId, { type: 'delivery.updated', delivery })
    }
    this.wakeDeliveries()
  }

  removeTarget(id: string, senderIdentity: string, participantId: string): boolean {
    const current = this.db.messages.get(id)
    this.assertUserOwner(current, senderIdentity)
    const dormant = this.db.transaction(() =>
      this.db.messages.deliveries.removeDormantTarget(id, participantId)
    )
    if (dormant) {
      dormant.deliveries.forEach((delivery) =>
        this.emit(current.roomId, { type: 'delivery.updated', delivery })
      )
      return dormant.deleteMessage
    }
    this.db.messages.deliveries.assertMessageMutable(id)
    const active = new Set(
      this.db.participants
        .list(current.roomId)
        .filter(
          (participant) =>
            participant.actorKind === 'agent' && participant.participation === 'active'
        )
        .map((participant) => participant.id)
    )
    const targets = this.db.messages.deliveries
      .listForMessage(id)
      .filter(
        (delivery) =>
          active.has(delivery.participantId) &&
          !(
            delivery.state === 'suppressed' &&
            (delivery.error === 'room_delivery_retargeted' ||
              delivery.error === 'room_participant_paused')
          )
      )
      .map((delivery) => delivery.participantId)
    if (!targets.includes(participantId)) {
      throw new Error('room_delivery_queue_stale')
    }
    const remaining = targets.filter((targetId) => targetId !== participantId)
    if (remaining.length === 0) {
      return true
    }
    this.retarget(id, senderIdentity, remaining)
    return false
  }

  reorder(
    participantId: string,
    deliveryIds: readonly string[],
    movedDeliveryId?: string,
    retargetMessageId?: string
  ): void {
    const participant = this.db.participants.get(participantId)
    const deliveries = this.db.transaction(() =>
      this.db.messages.deliveries.reorder(
        participantId,
        deliveryIds,
        movedDeliveryId,
        retargetMessageId
      )
    )
    for (const delivery of deliveries) {
      this.emit(participant.roomId, { type: 'delivery.updated', delivery })
    }
    this.wakeDeliveries()
  }

  reorderAll(
    roomId: string,
    messageIds: readonly string[],
    movedMessageId?: string,
    retargetMessageId?: string
  ): void {
    const deliveries = this.db.transaction(() =>
      this.db.messages.deliveries.reorderAll(roomId, messageIds, movedMessageId, retargetMessageId)
    )
    for (const delivery of deliveries) {
      this.emit(roomId, { type: 'delivery.updated', delivery })
    }
    this.wakeDeliveries()
  }

  async delete(id: string, senderIdentity: string): Promise<void> {
    const current = this.db.messages.get(id)
    this.assertUserOwner(current, senderIdentity)
    const paths = this.db.messages.delete([id])
    await this.attachments.remove(paths)
    this.emit(current.roomId, {
      type: 'message.deleted',
      messageId: id
    })
  }

  assertDeletable(id: string, senderIdentity: string): void {
    this.assertUserOwner(this.db.messages.get(id), senderIdentity)
    this.db.messages.deliveries.assertMessageMutable(id)
  }

  markRead(roomId: string, readerKey: string, sequence: number): RoomUnread {
    const unread = this.db.messages.markRead(roomId, readerKey, sequence)
    this.emit(roomId, { type: 'unread.updated', unread })
    return unread
  }

  private assertUserOwner(message: RoomMessage, senderIdentity: string): void {
    if (
      message.actorKind !== 'user' ||
      message.senderIdentity.toLowerCase() !== senderIdentity.toLowerCase()
    ) {
      throw new Error('room_message_forbidden')
    }
  }
}
