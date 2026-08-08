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
    const room = this.db.core.get(input.roomId)
    if (room.archivedAt) {
      throw new Error('room_archived')
    }
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
    let created
    try {
      attachments.push(
        ...(await this.attachments.consumeUploads(input.roomId, input.attachmentUploadIds ?? []))
      )
      created = this.db.messages.create({
        roomId: input.roomId,
        senderId: sender.id,
        senderIdentity: sender.identity,
        actorKind: sender.actorKind,
        body: input.body,
        replyToId: input.replyToId,
        mentions,
        attachments
      })
    } catch (error) {
      await this.attachments.remove(attachments.map((attachment) => attachment.localPath))
      throw error
    }
    this.emit(input.roomId, { type: 'message.created', message: created.message })
    for (const delivery of created.deliveries) {
      this.emit(input.roomId, { type: 'delivery.updated', delivery })
    }
    this.wakeDeliveries()
    return created.message
  }

  update(id: string, senderIdentity: string, body: string): RoomMessage {
    const current = this.db.messages.get(id)
    if (this.db.core.get(current.roomId).archivedAt) {
      throw new Error('room_archived')
    }
    this.assertUserOwner(current, senderIdentity)
    const message = this.db.messages.update(id, body)
    this.emit(message.roomId, { type: 'message.updated', message })
    return message
  }

  async delete(id: string, senderIdentity: string): Promise<void> {
    const current = this.db.messages.get(id)
    if (this.db.core.get(current.roomId).archivedAt) {
      throw new Error('room_archived')
    }
    this.assertUserOwner(current, senderIdentity)
    const paths = this.db.messages.delete([id])
    await this.attachments.remove(paths)
    this.emit(current.roomId, {
      type: 'message.deleted',
      messageId: id
    })
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
