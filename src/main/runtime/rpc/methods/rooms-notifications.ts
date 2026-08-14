import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../core'
import { replayRoomNotifications } from '../../rooms/notification-replay'

export const ROOM_NOTIFICATION_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'rooms.notifications.replay',
    params: z
      .object({
        afterSequence: z.number().int().nonnegative().nullable().optional(),
        limit: z.number().int().min(1).max(200).default(200)
      })
      .strict(),
    handler: async (params, { runtime }) => ({
      page: replayRoomNotifications(
        runtime.getRoomService().db,
        params.afterSequence ?? null,
        params.limit
      )
    })
  })
]
