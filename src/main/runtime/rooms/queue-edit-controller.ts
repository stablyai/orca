import type { RoomEvent, RoomMessage } from '../../../shared/rooms'
import type { RoomAttachmentManager } from './attachments'
import type { RoomDatabase } from './database'
import { validateRoomMentions } from './mentions'

export type FinishRoomQueueEditInput = {
  messageId: string
  editToken: string
  body: string
  mentions?: string[]
  retainedAttachmentIds?: string[]
  attachmentUploadIds?: string[]
}

export class RoomQueueEditController {
  constructor(
    private readonly db: RoomDatabase,
    private readonly attachments: RoomAttachmentManager,
    private readonly emit: (roomId: string, event: RoomEvent) => void,
    private readonly wakeDeliveries: () => void,
    private readonly assertWritable: (roomId: string) => void,
    private readonly run: <T>(roomId: string, action: () => Promise<T>) => Promise<T>
  ) {}

  begin(id: string): {
    message: RoomMessage
    editToken: string
    targetParticipantIds: string[] | null
  } {
    const current = this.db.messages.get(id)
    this.assertWritable(current.roomId)
    assertUserOwner(current, this.db.participants.getUser(current.roomId).identity)
    const editToken = this.db.transaction(() => this.db.queueEdits.begin(id))
    const message = this.db.messages.get(id)
    const active = this.db.participants
      .list(message.roomId)
      .filter(
        (participant) => participant.actorKind === 'agent' && participant.participation === 'active'
      )
    const targets = this.db.messages.deliveries
      .listForMessage(id)
      .filter(
        (delivery) =>
          active.some((participant) => participant.id === delivery.participantId) &&
          !(
            delivery.state === 'suppressed' &&
            (delivery.error === 'room_delivery_retargeted' ||
              delivery.error === 'room_participant_paused')
          )
      )
      .map((delivery) => delivery.participantId)
    this.emit(message.roomId, { type: 'message.updated', message })
    return {
      message,
      editToken,
      targetParticipantIds: targets.length === active.length ? null : targets
    }
  }

  finish(input: FinishRoomQueueEditInput): Promise<RoomMessage> {
    const current = this.db.messages.get(input.messageId)
    return this.run(current.roomId, () => this.finishWritable(input, current))
  }

  cancel(id: string, editToken: string): RoomMessage {
    const current = this.db.messages.get(id)
    this.assertWritable(current.roomId)
    assertUserOwner(current, this.db.participants.getUser(current.roomId).identity)
    this.db.transaction(() => this.db.queueEdits.cancel(id, editToken))
    const message = this.db.messages.get(id)
    this.emit(message.roomId, { type: 'message.updated', message })
    this.wakeDeliveries()
    return message
  }

  private async finishWritable(
    input: FinishRoomQueueEditInput,
    current: RoomMessage
  ): Promise<RoomMessage> {
    assertUserOwner(current, this.db.participants.getUser(current.roomId).identity)
    const mentions = validateRoomMentions(
      input.mentions ?? [],
      this.db.participants.list(current.roomId)
    )
    const retainedAttachmentIds = input.retainedAttachmentIds ?? []
    const attachmentUploadIds = input.attachmentUploadIds ?? []
    if (retainedAttachmentIds.length + attachmentUploadIds.length > 10) {
      throw new Error('room_attachment_count_exceeded')
    }
    this.db.queueEdits.assertMutable(input.messageId, input.editToken)
    const attachments = await this.attachments.consumeUploads(current.roomId, attachmentUploadIds)
    let removedPaths: string[]
    try {
      removedPaths = this.db.transaction(() =>
        this.db.queueEdits.finish({
          ...input,
          mentions,
          retainedAttachmentIds,
          attachments
        })
      )
    } catch (error) {
      await this.attachments.remove(attachments.map((attachment) => attachment.localPath))
      throw error
    }
    await this.attachments.remove(removedPaths)
    const message = this.db.messages.get(input.messageId)
    this.emit(message.roomId, { type: 'message.updated', message })
    this.wakeDeliveries()
    return message
  }
}

function assertUserOwner(message: RoomMessage, senderIdentity: string): void {
  if (
    message.actorKind !== 'user' ||
    message.senderIdentity.toLowerCase() !== senderIdentity.toLowerCase()
  ) {
    throw new Error('room_message_forbidden')
  }
}
