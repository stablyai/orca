import type { RoomMessagePage } from '../../../shared/rooms'
import type { RoomDatabase } from './database'
import type { RoomDeliveryWorker } from './delivery-worker'
import type { RoomMessageController } from './message-controller'

export class RoomQueueController {
  constructor(
    private readonly db: RoomDatabase,
    private readonly messages: RoomMessageController,
    private readonly worker: RoomDeliveryWorker,
    private readonly assertWritable: (roomId: string) => void
  ) {}

  list(roomId: string): Pick<RoomMessagePage, 'messages' | 'deliveries'> {
    this.assertWritable(roomId)
    return this.db.messages.listQueued(roomId)
  }

  retarget(messageId: string, participantIds: readonly string[]): void {
    const message = this.db.messages.get(messageId)
    this.assertWritable(message.roomId)
    const user = this.db.participants.getUser(message.roomId)
    this.messages.retarget(messageId, user.identity, participantIds)
  }

  removeTarget(messageId: string, participantId: string): string | null {
    const message = this.db.messages.get(messageId)
    this.assertWritable(message.roomId)
    const user = this.db.participants.getUser(message.roomId)
    return this.messages.removeTarget(messageId, user.identity, participantId)
      ? user.identity
      : null
  }

  reorder(
    participantId: string,
    deliveryIds: readonly string[],
    movedDeliveryId?: string,
    retargetMessageId?: string
  ): void {
    const participant = this.db.participants.get(participantId)
    this.assertWritable(participant.roomId)
    this.messages.reorder(participantId, deliveryIds, movedDeliveryId, retargetMessageId)
  }

  reorderAll(
    roomId: string,
    messageIds: readonly string[],
    movedMessageId?: string,
    retargetMessageId?: string
  ): void {
    this.assertWritable(roomId)
    this.messages.reorderAll(roomId, messageIds, movedMessageId, retargetMessageId)
  }

  async steer(deliveryId: string, group = false): Promise<void> {
    const delivery = this.db.messages.deliveries.get(deliveryId)
    this.assertWritable(this.db.messages.get(delivery.messageId).roomId)
    await this.worker.steer(deliveryId, group)
  }

  wake(): void {
    this.worker.wake()
  }
}
