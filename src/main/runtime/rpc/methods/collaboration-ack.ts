import { z } from 'zod'
import { requireLocalCollaborationDispatchAuthority } from '../../collaboration/collaboration-dispatch-authority'
import { ackCollaborationCheckpoint } from '../../collaboration/collaboration-checkpoint-store'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'

const CollaborationAckParams = z.object({
  from: requiredString('Missing --from'),
  messageIds: z
    .array(z.string().min(1, 'messageIds must be non-empty strings'))
    .min(1, 'messageIds must contain at least one id')
    .max(100, 'messageIds must contain at most 100 ids')
})

export const COLLABORATION_ACK_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.collaborationAck',
    params: CollaborationAckParams,
    handler: async (params, { runtime, orchestrationCapability }) => {
      // Why: local-only — the Task identity comes from the authenticated
      // terminal's active Dispatch, never from caller-supplied ids.
      const dispatch = requireLocalCollaborationDispatchAuthority(
        runtime,
        params.from,
        orchestrationCapability
      )
      const duplicate = ackCollaborationCheckpoint(
        runtime.getOrchestrationDb(),
        dispatch.task_id,
        params.messageIds
      )
      return { messageIds: [...params.messageIds], duplicate }
    }
  })
]
