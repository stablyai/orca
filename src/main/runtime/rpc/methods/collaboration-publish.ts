import { z } from 'zod'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { requireLocalCollaborationDispatchAuthority } from '../../collaboration/collaboration-dispatch-authority'
import { getCollaborationRuntimeTopology } from '../../collaboration/collaboration-runtime-registry'
import {
  allowedPublishTopicsForTask,
  subscribersForTopic
} from '../../collaboration/collaboration-topology'
import { publishCollaborationMessage } from '../../collaboration/collaboration-publish-store'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString, requiredStringAllowingEmpty } from '../schemas'

const CollaborationPublishParams = z.object({
  from: requiredString('Missing --from'),
  topic: requiredString('Missing --topic'),
  semanticType: requiredString('Missing --semanticType'),
  priority: z.enum(['normal', 'high', 'urgent']),
  body: requiredStringAllowingEmpty('Missing --body')
})

export const COLLABORATION_PUBLISH_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.collaborationPublish',
    params: CollaborationPublishParams,
    handler: async (params, { runtime, orchestrationCapability, orchestrationMutation }) => {
      // Why: local-only — the sender's Dispatch and Task identity come from
      // the authenticated terminal, never from caller-supplied ids.
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
      if (!allowedPublishTopicsForTask(topology, dispatch.task_id).includes(params.topic)) {
        throw new OrchestrationError(
          'collaboration_topic_not_allowed',
          `Task ${dispatch.task_id} is not allowed to publish to topic ${params.topic}.`
        )
      }
      if (!orchestrationMutation) {
        throw new OrchestrationError(
          'invalid_argument',
          'collaborationPublish requires a durable retry request.'
        )
      }
      const subscriberTaskIds = subscribersForTopic(topology, params.topic)
      const rows = publishCollaborationMessage(runtime.getOrchestrationDb(), {
        runId: dispatch.run_id,
        publicationId: orchestrationMutation.requestId,
        producerTaskId: dispatch.task_id,
        subscriberTaskIds,
        topic: params.topic,
        semanticType: params.semanticType,
        priority: params.priority,
        body: params.body
      })
      for (const row of rows) {
        runtime.notifyMessageArrived(row.to_handle, row.type)
      }
      return {
        publicationId: orchestrationMutation.requestId,
        messageIds: rows.map((row) => row.id),
        subscriberTaskIds
      }
    }
  })
]
