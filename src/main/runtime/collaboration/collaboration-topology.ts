import { OrchestrationError } from '../orchestration/orchestration-error'
import type { MessagePriority } from '../orchestration/types'
import { isCollaborationMessageAdmitted, type AdmissionPolicy } from './collaboration-admission'

export type CollaborationTopologyStep = {
  taskId: string
  readonly publishesTo?: readonly string[]
  readonly requiredPublishesTo?: readonly string[]
  readonly subscribesTo?: readonly string[]
  admission?: AdmissionPolicy
}

export type CollaborationTopology = {
  readonly steps: readonly CollaborationTopologyStep[]
}

export type CollaborationPublishAdmissionOption = {
  semanticType: string
  minPriority: MessagePriority
}

const MESSAGE_PRIORITIES: readonly MessagePriority[] = ['normal', 'high', 'urgent']

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
    throw new OrchestrationError(
      'invalid_argument',
      'collaboration topology requires at least one step'
    )
  }
  const seenTaskIds = new Set<string>()
  const copiedSteps: CollaborationTopologyStep[] = steps.map((step) => {
    if (seenTaskIds.has(step.taskId)) {
      throw new OrchestrationError(
        'invalid_argument',
        `duplicate taskId in collaboration topology: ${step.taskId}`
      )
    }
    if (step.taskId.trim() === '') {
      throw new OrchestrationError(
        'invalid_argument',
        `taskId must be non-empty in collaboration topology: ${JSON.stringify(step.taskId)}`
      )
    }
    seenTaskIds.add(step.taskId)
    const subscribesTo = dedupePreservingOrder(step.subscribesTo)
    if (subscribesTo !== undefined && subscribesTo.length > 0 && step.admission === undefined) {
      throw new OrchestrationError(
        'invalid_argument',
        `step ${step.taskId} subscribes to topics but has no admission policy`
      )
    }
    return {
      taskId: step.taskId,
      ...(step.publishesTo !== undefined && {
        publishesTo: dedupePreservingOrder(step.publishesTo)
      }),
      ...(step.requiredPublishesTo !== undefined && {
        requiredPublishesTo: dedupePreservingOrder(step.requiredPublishesTo)
      }),
      ...(subscribesTo !== undefined && { subscribesTo }),
      ...(step.admission !== undefined && { admission: copyPolicy(step.admission) })
    }
  })
  for (const step of copiedSteps) {
    const required = step.requiredPublishesTo
    if (required === undefined) {
      continue
    }
    const publishes = step.publishesTo ?? []
    for (const topic of required) {
      if (!publishes.includes(topic)) {
        throw new OrchestrationError(
          'invalid_argument',
          `step ${step.taskId} requires publishing topic ${topic} but does not publish it`
        )
      }
      if (!copiedSteps.some((s) => s.subscribesTo?.includes(topic) ?? false)) {
        throw new OrchestrationError(
          'invalid_argument',
          `required topic ${topic} of step ${step.taskId} has no subscribers`
        )
      }
    }
  }
  return { steps: copiedSteps }
}

export function allowedPublishTopicsForTask(
  topology: CollaborationTopology,
  taskId: string
): readonly string[] {
  return topology.steps.find((step) => step.taskId === taskId)?.publishesTo ?? []
}

export function requiredPublishTopicsForTask(
  topology: CollaborationTopology,
  taskId: string
): readonly string[] {
  return [...(topology.steps.find((step) => step.taskId === taskId)?.requiredPublishesTo ?? [])]
}

export function subscribersForTopic(
  topology: CollaborationTopology,
  topic: string
): readonly string[] {
  return topology.steps
    .filter((step) => step.subscribesTo?.includes(topic) ?? false)
    .map((step) => step.taskId)
}

export function admittedPublishOptionsForTopic(
  topology: CollaborationTopology,
  topic: string
): readonly CollaborationPublishAdmissionOption[] {
  const policies = topology.steps
    .filter((step) => step.subscribesTo?.includes(topic) ?? false)
    .map((step) => step.admission)
    .filter((policy): policy is AdmissionPolicy => policy !== undefined)
  const seenTypes = new Set<string>()
  const semanticTypes: string[] = []
  for (const policy of policies) {
    for (const semanticType of policy.acceptedTypes) {
      if (!seenTypes.has(semanticType)) {
        seenTypes.add(semanticType)
        semanticTypes.push(semanticType)
      }
    }
  }
  return semanticTypes.flatMap((semanticType) => {
    const minPriority = MESSAGE_PRIORITIES.find((priority) =>
      policies.some((policy) =>
        isCollaborationMessageAdmitted({ type: semanticType, priority }, policy)
      )
    )
    return minPriority ? [{ semanticType, minPriority }] : []
  })
}

export function admissionPolicyForTask(
  topology: CollaborationTopology,
  taskId: string
): AdmissionPolicy | undefined {
  return topology.steps.find((step) => step.taskId === taskId)?.admission
}
