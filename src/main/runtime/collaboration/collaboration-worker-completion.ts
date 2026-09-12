import type { OrcaRuntimeService } from '../orca-runtime'
import { findMissingCollaborationTopics } from './collaboration-publication-facts'
import { getCollaborationRuntimeTopology } from './collaboration-runtime-registry'
import { requiredPublishTopicsForTask } from './collaboration-topology'

export type CollaborationWorkerCompletionBlock = {
  code: 'collaboration_publish_incomplete'
  reason: string
  missingTopics: readonly string[]
}

export function getCollaborationWorkerCompletionBlock(
  runtime: OrcaRuntimeService,
  input: { runId: string; taskId: string; outcome: 'succeeded' | 'failed' }
): CollaborationWorkerCompletionBlock | undefined {
  if (input.outcome !== 'succeeded') {
    return undefined
  }
  const topology = getCollaborationRuntimeTopology(runtime, input.runId)
  if (!topology) {
    return undefined
  }
  const requiredTopics = requiredPublishTopicsForTask(topology, input.taskId)
  if (requiredTopics.length === 0) {
    return undefined
  }
  const missingTopics = findMissingCollaborationTopics(runtime.getOrchestrationDb(), {
    runId: input.runId,
    producerTaskId: input.taskId,
    requiredTopics
  })
  if (missingTopics.length === 0) {
    return undefined
  }
  return {
    code: 'collaboration_publish_incomplete',
    reason:
      `Task ${input.taskId} must publish required collaboration topics before ` +
      `succeeded worker_done: ${missingTopics.join(', ')}`,
    missingTopics
  }
}
