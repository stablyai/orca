import { RoomsParticipantsExistingParams } from '../../../../shared/rpc-contract/rooms-participant-existing-params'

import { withoutRoomAgentOwners } from '../../rooms/participant-ownership'
import { defineMethod } from '../core'

export const ROOM_EXISTING_PARTICIPANT_METHOD = defineMethod({
  name: 'rooms.participants.existing',
  params: RoomsParticipantsExistingParams,
  handler: async (params, { runtime }) => {
    const service = runtime.getRoomService()
    return {
      participants: withoutRoomAgentOwners(
        service.db.participants,
        await runtime.listRoomExistingAgents(
          params.worktreeId,
          params.agent,
          params.machineStreaming === true
        ),
        params.worktreeId,
        params.agent
      )
    }
  }
})
