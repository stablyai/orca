import type { RoomActorKind, RoomAttachment, RoomMessage } from '../../../shared/rooms'

export type CreateRoomMessage = {
  id?: string
  roomId: string
  senderId: string | null
  senderIdentity: string
  actorKind: RoomActorKind
  kind?: RoomMessage['kind']
  body: string
  replyToId?: string | null
  metadata?: Record<string, unknown>
  mentions?: string[]
  attachments?: (Omit<RoomAttachment, 'messageId' | 'createdAt'> & { createdAt?: number })[]
  createdAt?: number
  editedAt?: number | null
  deletedAt?: number | null
  enqueueDeliveries?: boolean
  targetParticipantIds?: string[]
}
