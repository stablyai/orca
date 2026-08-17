import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../core'
import { MessageId, ParticipantId, RoomId } from './rooms-schemas'

export const ROOM_QUEUE_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'rooms.messages.beginQueueEdit',
    params: z.object({ messageId: MessageId }).strict(),
    handler: (params, { runtime }) => runtime.getRoomService().queueEdits.begin(params.messageId)
  }),
  defineMethod({
    name: 'rooms.messages.finishQueueEdit',
    params: z
      .object({
        messageId: MessageId,
        editToken: z.string().uuid(),
        body: z.string().max(262_144),
        mentions: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
        retainedAttachmentIds: z.array(z.string().uuid()).max(10).optional(),
        attachmentUploadIds: z.array(z.string().uuid()).max(10).optional()
      })
      .strict(),
    handler: async (params, { runtime }) => ({
      message: await runtime.getRoomService().queueEdits.finish(params)
    })
  }),
  defineMethod({
    name: 'rooms.messages.cancelQueueEdit',
    params: z.object({ messageId: MessageId, editToken: z.string().uuid() }).strict(),
    handler: (params, { runtime }) => ({
      message: runtime.getRoomService().queueEdits.cancel(params.messageId, params.editToken)
    })
  }),
  defineMethod({
    name: 'rooms.deliveries.queue',
    params: z.object({ roomId: RoomId }).strict(),
    handler: async (params, { runtime }) => ({
      queue: runtime.getRoomService().queue.list(params.roomId)
    })
  }),
  defineMethod({
    name: 'rooms.messages.retarget',
    params: z.union([
      z.object({ messageId: MessageId, participantIds: z.array(ParticipantId).max(50) }).strict(),
      z.object({ messageId: MessageId, removeParticipantId: ParticipantId }).strict()
    ]),
    handler: async (params, { runtime }) => {
      const service = runtime.getRoomService()
      if ('removeParticipantId' in params) {
        const deleteIdentity = service.queue.removeTarget(
          params.messageId,
          params.removeParticipantId
        )
        if (deleteIdentity) {
          // deleteMessage fences deliveries before yielding, preserving this target-count decision.
          await service.deleteMessage(params.messageId, deleteIdentity)
        }
      } else {
        service.queue.retarget(params.messageId, params.participantIds)
      }
      return { accepted: true }
    }
  }),
  defineMethod({
    name: 'rooms.deliveries.reorder',
    params: z.union([
      z
        .object({
          participantId: ParticipantId,
          deliveryIds: z.array(z.string().uuid()).max(200)
        })
        .strict(),
      z
        .object({
          participantId: ParticipantId,
          deliveryIds: z.array(z.string().uuid()).max(200),
          movedDeliveryId: z.string().uuid()
        })
        .strict(),
      z
        .object({
          participantId: ParticipantId,
          deliveryIds: z.array(z.string().uuid()).max(200),
          retargetMessageId: MessageId
        })
        .strict()
    ]),
    handler: async (params, { runtime }) => {
      runtime
        .getRoomService()
        .queue.reorder(
          params.participantId,
          params.deliveryIds,
          'movedDeliveryId' in params ? params.movedDeliveryId : undefined,
          'retargetMessageId' in params ? params.retargetMessageId : undefined
        )
      return { accepted: true }
    }
  }),
  defineMethod({
    name: 'rooms.messages.reorderQueue',
    params: z.union([
      z.object({ roomId: RoomId, messageIds: z.array(MessageId).max(200) }).strict(),
      z
        .object({
          roomId: RoomId,
          messageIds: z.array(MessageId).max(200),
          movedMessageId: MessageId
        })
        .strict(),
      z
        .object({
          roomId: RoomId,
          messageIds: z.array(MessageId).max(200),
          retargetMessageId: MessageId
        })
        .strict()
    ]),
    handler: async (params, { runtime }) => {
      runtime
        .getRoomService()
        .queue.reorderAll(
          params.roomId,
          params.messageIds,
          'movedMessageId' in params ? params.movedMessageId : undefined,
          'retargetMessageId' in params ? params.retargetMessageId : undefined
        )
      return { accepted: true }
    }
  }),
  defineMethod({
    name: 'rooms.deliveries.steer',
    params: z.union([
      z.object({ deliveryId: z.string().uuid() }).strict(),
      z.object({ deliveryId: z.string().uuid(), group: z.literal(true) }).strict()
    ]),
    handler: async (params, { runtime }) => {
      await runtime.getRoomService().queue.steer(params.deliveryId, 'group' in params)
      return { accepted: true }
    }
  })
]
