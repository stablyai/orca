import { z } from 'zod'
import { withoutRoomAgentOwners } from '../../rooms/participant-ownership'
import { defineMethod } from '../core'
import { HarnessAgent } from './rooms-schemas'

export const ROOM_EXISTING_PARTICIPANT_METHOD = defineMethod({
  name: 'rooms.participants.existing',
  params: z
    .object({
      worktreeId: z.string().trim().min(1).max(1024),
      agent: HarnessAgent,
      machineStreaming: z.boolean().optional()
    })
    .strict(),
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
