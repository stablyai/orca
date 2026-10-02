import { RoomsNotificationsReplayParams } from '../../../../shared/rpc-contract/rooms-notifications-params'

import { defineMethod } from '../core'
import { replayRoomNotifications } from '../../rooms/notification-replay'

export const ROOM_NOTIFICATION_METHODS = [
  defineMethod({
    name: 'rooms.notifications.replay',
    params: RoomsNotificationsReplayParams,
    handler: async (params, { runtime }) => ({
      page: replayRoomNotifications(
        runtime.getRoomService().db,
        params.afterSequence ?? null,
        params.limit
      )
    })
  })
]
