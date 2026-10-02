import {
  RoomsWorkStopParams,
  RoomsWorkResumeParams
} from '../../../../shared/rpc-contract/rooms-work-params'

import { defineMethod } from '../core'

export const ROOM_WORK_METHODS = [
  defineMethod({
    name: 'rooms.work.stop',
    params: RoomsWorkStopParams,
    handler: async (params, { runtime }) => ({
      stopped: await runtime.getRoomService().stopRoom(params.roomId)
    })
  }),
  defineMethod({
    name: 'rooms.work.resume',
    params: RoomsWorkResumeParams,
    handler: async (params, { runtime }) => ({
      resumed: await runtime.getRoomService().resumeRoom(params.roomId)
    })
  })
]
