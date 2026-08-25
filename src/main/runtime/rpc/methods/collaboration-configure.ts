import { z } from 'zod'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  createCollaborationTopology,
  type CollaborationTopologyStep
} from '../../collaboration/collaboration-topology'
import {
  getCollaborationRuntimeTopology,
  registerCollaborationRuntimeTopology
} from '../../collaboration/collaboration-runtime-registry'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'
import { resolveRunScope } from './orchestration-run-scope'

const TopicList = z
  .array(z.string().min(1, 'topic names must be non-empty'))
  .max(32, 'a step may declare at most 32 topics')

const CollaborationStep = z.object({
  taskId: z.string().min(1, 'taskId must be non-empty'),
  publishesTo: TopicList.optional(),
  requiredPublishesTo: TopicList.optional(),
  subscribesTo: TopicList.optional(),
  admission: z
    .object({
      acceptedTypes: TopicList.min(1, 'at least one accepted type is required'),
      minPriority: z.enum(['normal', 'high', 'urgent'])
    })
    .optional()
})

const CollaborationConfigureParams = z.object({
  run: z.string().min(1, 'run must be non-empty').optional(),
  from: requiredString('Missing --from'),
  steps: z
    .array(CollaborationStep)
    .min(1, 'at least one step is required')
    .max(64, 'at most 64 steps are allowed')
})

// Why: coordinator-owned — the run binding comes from the coordinator's pane,
// never from caller-supplied ids, so no caller can configure a foreign run.
export const COLLABORATION_CONFIGURE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.collaborationConfigure',
    params: CollaborationConfigureParams,
    handler: (params, { runtime, orchestrationCompatibilityEvidence, legacyCoordinatorRunId }) => {
      const db = runtime.getOrchestrationDb()
      const run = resolveRunScope(runtime, {
        runId: params.run,
        callerTerminalHandle: params.from,
        requireCurrentConsumer: true,
        legacyCoordinatorRunId,
        callerEvidence: orchestrationCompatibilityEvidence
      })
      for (const step of params.steps) {
        const task = db.getTask(step.taskId)
        if (!task || task.run_id !== run.id) {
          throw new OrchestrationError(
            'task_not_found',
            `Task ${step.taskId} was not found in Run ${run.id}.`
          )
        }
      }
      if (getCollaborationRuntimeTopology(runtime, run.id)) {
        throw new OrchestrationError(
          'collaboration_topology_exists',
          `A collaboration topology is already registered for run ${run.id}.`
        )
      }
      const topology = createCollaborationTopology(params.steps as CollaborationTopologyStep[])
      registerCollaborationRuntimeTopology(runtime, run.id, topology)
      return { runId: run.id, stepCount: topology.steps.length }
    }
  })
]
