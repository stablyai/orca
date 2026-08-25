import { z } from 'zod'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { requireLocalCollaborationDispatchAuthority } from '../../collaboration/collaboration-dispatch-authority'
import { getCollaborationRuntimeTopology } from '../../collaboration/collaboration-runtime-registry'
import { admissionPolicyForTask } from '../../collaboration/collaboration-topology'
import { prepareCollaborationCheckpoint } from '../../collaboration/collaboration-checkpoint-store'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'

const CollaborationCheckpointParams = z.object({
  from: requiredString('Missing --from'),
  limit: z
    .number()
    .int('limit must be an integer between 1 and 100')
    .min(1, 'limit must be an integer between 1 and 100')
    .max(100, 'limit must be an integer between 1 and 100')
    .optional()
})

// Why: task identity comes from the authenticated terminal's active Dispatch;
// admission-filtered collaboration rows may be consumed during prepare.
export const COLLABORATION_CHECKPOINT_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.collaborationCheckpoint',
    params: CollaborationCheckpointParams,
    handler: async (params, { runtime, orchestrationCapability }) => {
      const dispatch = requireLocalCollaborationDispatchAuthority(
        runtime,
        params.from,
        orchestrationCapability
      )
      const topology = getCollaborationRuntimeTopology(runtime, dispatch.run_id)
      if (!topology) {
        throw new OrchestrationError(
          'collaboration_topology_unavailable',
          `No collaboration topology is registered for run ${dispatch.run_id}.`
        )
      }
      const policy = admissionPolicyForTask(topology, dispatch.task_id)
      if (!policy) {
        throw new OrchestrationError(
          'collaboration_subscription_unavailable',
          `Task ${dispatch.task_id} has no collaboration subscription admission policy.`
        )
      }
      return prepareCollaborationCheckpoint(
        runtime.getOrchestrationDb(),
        dispatch.task_id,
        policy,
        params.limit
      )
    }
  })
]
