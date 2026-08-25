import { z } from 'zod'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { requireLocalCollaborationDispatchAuthority } from '../../collaboration/collaboration-dispatch-authority'
import { getCollaborationRuntimeTopology } from '../../collaboration/collaboration-runtime-registry'
import { admissionPolicyForTask } from '../../collaboration/collaboration-topology'
import {
  prepareCollaborationCheckpoint,
  type CollaborationCheckpointResult
} from '../../collaboration/collaboration-checkpoint-store'
import { buildCollaborationTaskMailboxAddress } from '../../collaboration/collaboration-task-mailbox'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'

const CollaborationCheckpointParams = z.object({
  from: requiredString('Missing --from'),
  limit: z
    .number()
    .int('limit must be an integer between 1 and 100')
    .min(1, 'limit must be an integer between 1 and 100')
    .max(100, 'limit must be an integer between 1 and 100')
    .optional(),
  wait: z.boolean().optional(),
  timeoutMs: z
    .number()
    .int('timeoutMs must be an integer between 1 and 600000')
    .min(1, 'timeoutMs must be an integer between 1 and 600000')
    .max(600000, 'timeoutMs must be an integer between 1 and 600000')
    .optional()
})

const DEFAULT_WAIT_TIMEOUT_MS = 60000

// Why: task identity comes from the authenticated terminal's active Dispatch;
// admission-filtered collaboration rows may be consumed during prepare.
export const COLLABORATION_CHECKPOINT_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.collaborationCheckpoint',
    params: CollaborationCheckpointParams,
    handler: async (params, { runtime, orchestrationCapability, signal }) => {
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
      const db = runtime.getOrchestrationDb()
      const mailbox = buildCollaborationTaskMailboxAddress(dispatch.task_id)

      if (!params.wait) {
        const result = prepareCollaborationCheckpoint(db, dispatch.task_id, policy, params.limit)
        return {
          entries: [...result.entries],
          filteredMessageIds: [...result.filteredMessageIds],
          timedOut: false,
          cancelled: false
        }
      }

      const deadline = Date.now() + (params.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)
      const filteredMessageIds: string[] = []
      const seenFiltered = new Set<string>()
      // Why: non-wait prepare ran above only for the !wait branch; here each
      // loop iteration prepares fresh and consumes filtered rows before waiting.
      for (;;) {
        const result: CollaborationCheckpointResult = prepareCollaborationCheckpoint(
          db,
          dispatch.task_id,
          policy,
          params.limit
        )
        for (const id of result.filteredMessageIds) {
          if (!seenFiltered.has(id)) {
            seenFiltered.add(id)
            filteredMessageIds.push(id)
          }
        }
        if (result.entries.length > 0) {
          return {
            entries: [...result.entries],
            filteredMessageIds,
            timedOut: false,
            cancelled: false
          }
        }
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          return { entries: [], filteredMessageIds, timedOut: true, cancelled: false }
        }
        const waitResult = await runtime.waitForMessage(mailbox, {
          timeoutMs: remaining,
          signal,
          exclusive: true
        })
        if (waitResult === 'timed_out') {
          return { entries: [], filteredMessageIds, timedOut: true, cancelled: false }
        }
        if (waitResult === 'cancelled') {
          return { entries: [], filteredMessageIds, timedOut: false, cancelled: true }
        }
        if (waitResult === 'waiter_exists') {
          throw new OrchestrationError(
            'waiter_exists',
            `Another waiter already holds the collaboration mailbox ${mailbox}.`
          )
        }
        // 'notified' — loop to prepare and consume the new message.
      }
    }
  })
]
