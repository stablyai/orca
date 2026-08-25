import type { AdmissionPolicy } from './collaboration-admission'

export type CollaborationTopologyStep = {
  taskId: string
  readonly publishesTo?: readonly string[]
  readonly subscribesTo?: readonly string[]
  admission?: AdmissionPolicy
}

export type CollaborationTopology = {
  readonly steps: readonly CollaborationTopologyStep[]
}

function dedupePreservingOrder(
  topics: readonly string[] | undefined
): readonly string[] | undefined {
  if (topics === undefined) {
    return undefined
  }
  return [...new Set(topics)]
}

function copyPolicy(policy: AdmissionPolicy): AdmissionPolicy {
  return { acceptedTypes: [...policy.acceptedTypes], minPriority: policy.minPriority }
}

export function createCollaborationTopology(
  steps: readonly CollaborationTopologyStep[]
): CollaborationTopology {
  if (steps.length === 0) {
    throw new Error('collaboration topology requires at least one step')
  }
  const seenTaskIds = new Set<string>()
  const copiedSteps: CollaborationTopologyStep[] = steps.map((step) => {
    if (seenTaskIds.has(step.taskId)) {
      throw new Error(`duplicate taskId in collaboration topology: ${step.taskId}`)
    }
    if (step.taskId.trim() === '') {
      throw new Error(
        `taskId must be non-empty in collaboration topology: ${JSON.stringify(step.taskId)}`
      )
    }
    seenTaskIds.add(step.taskId)
    const subscribesTo = dedupePreservingOrder(step.subscribesTo)
    if (subscribesTo !== undefined && subscribesTo.length > 0 && step.admission === undefined) {
      throw new Error(`step ${step.taskId} subscribes to topics but has no admission policy`)
    }
    return {
      taskId: step.taskId,
      ...(step.publishesTo !== undefined && {
        publishesTo: dedupePreservingOrder(step.publishesTo)
      }),
      ...(subscribesTo !== undefined && { subscribesTo }),
      ...(step.admission !== undefined && { admission: copyPolicy(step.admission) })
    }
  })
  return { steps: copiedSteps }
}

export function allowedPublishTopicsForTask(
  topology: CollaborationTopology,
  taskId: string
): readonly string[] {
  return topology.steps.find((step) => step.taskId === taskId)?.publishesTo ?? []
}

export function subscribersForTopic(
  topology: CollaborationTopology,
  topic: string
): readonly string[] {
  return topology.steps
    .filter((step) => step.subscribesTo?.includes(topic) ?? false)
    .map((step) => step.taskId)
}

export function admissionPolicyForTask(
  topology: CollaborationTopology,
  taskId: string
): AdmissionPolicy | undefined {
  return topology.steps.find((step) => step.taskId === taskId)?.admission
}
