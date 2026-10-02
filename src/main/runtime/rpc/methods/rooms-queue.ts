import {
  RoomsMessagesBeginQueueEditParams,
  RoomsMessagesFinishQueueEditParams,
  RoomsMessagesCancelQueueEditParams,
  RoomsDeliveriesQueueParams,
  RoomsMessagesRetargetParams,
  RoomsDeliveriesReorderParams,
  RoomsMessagesReorderQueueParams,
  RoomsDeliveriesSteerParams
} from '../../../../shared/rpc-contract/rooms-queue-params'
import { defineMethod } from '../core'

export const ROOM_QUEUE_METHODS = [
  defineMethod({
    name: 'rooms.messages.beginQueueEdit',
    params: RoomsMessagesBeginQueueEditParams,
    handler: (params, { runtime }) => runtime.getRoomService().queueEdits.begin(params.messageId)
  }),
  defineMethod({
    name: 'rooms.messages.finishQueueEdit',
    params: RoomsMessagesFinishQueueEditParams,
    handler: async (params, { runtime }) => ({
      message: await runtime.getRoomService().queueEdits.finish(params)
    })
  }),
  defineMethod({
    name: 'rooms.messages.cancelQueueEdit',
    params: RoomsMessagesCancelQueueEditParams,
    handler: (params, { runtime }) => ({
      message: runtime.getRoomService().queueEdits.cancel(params.messageId, params.editToken)
    })
  }),
  defineMethod({
    name: 'rooms.deliveries.queue',
    params: RoomsDeliveriesQueueParams,
    handler: async (params, { runtime }) => ({
      queue: runtime.getRoomService().queue.list(params.roomId)
    })
  }),
  defineMethod({
    name: 'rooms.messages.retarget',
    params: RoomsMessagesRetargetParams,
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
    params: RoomsDeliveriesReorderParams,
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
    params: RoomsMessagesReorderQueueParams,
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
    params: RoomsDeliveriesSteerParams,
    handler: async (params, { runtime }) => {
      await runtime.getRoomService().queue.steer(params.deliveryId, 'group' in params)
      return { accepted: true }
    }
  })
]
