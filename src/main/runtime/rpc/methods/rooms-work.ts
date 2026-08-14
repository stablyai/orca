import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../core'
import { RoomId } from './rooms-schemas'

export const ROOM_WORK_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'rooms.work.stop',
    params: z.object({ roomId: RoomId }).strict(),
    handler: async (params, { runtime }) => ({
      stopped: await runtime.getRoomService().stopRoom(params.roomId)
    })
  }),
  defineMethod({
    name: 'rooms.work.resume',
    params: z.object({ roomId: RoomId }).strict(),
    handler: async (params, { runtime }) => ({
      resumed: await runtime.getRoomService().resumeRoom(params.roomId)
    })
  })
]
