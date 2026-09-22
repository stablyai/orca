import { OrchestrationError } from '../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../orca-runtime'
import {
  createCollaborationTopology,
  type CollaborationTopology,
  type CollaborationTopologyStep
} from './collaboration-topology'

type PersistedCollaborationTopology = {
  version: 1
  steps: readonly CollaborationTopologyStep[]
}

export function registerCollaborationRuntimeTopology(
  runtime: OrcaRuntimeService,
  runId: string,
  topology: CollaborationTopology
): void {
  runtime
    .getOrchestrationDb()
    .setRunCollaborationTopology(runId, serializeCollaborationTopology(topology))
}

export function getCollaborationRuntimeTopology(
  runtime: OrcaRuntimeService,
  runId: string
): CollaborationTopology | undefined {
  const serialized = runtime.getOrchestrationDb().getRunCollaborationTopology(runId)
  if (serialized === undefined || serialized === null) {
    return undefined
  }
  return parseCollaborationTopology(runId, serialized)
}

export function unregisterCollaborationRuntimeTopology(
  runtime: OrcaRuntimeService,
  runId: string
): void {
  runtime.getOrchestrationDb().clearRunCollaborationTopology(runId)
}

function serializeCollaborationTopology(topology: CollaborationTopology): string {
  return JSON.stringify({
    version: 1,
    steps: topology.steps
  } satisfies PersistedCollaborationTopology)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isPersistedCollaborationStep(value: unknown): value is CollaborationTopologyStep {
  if (!isRecord(value) || typeof value.taskId !== 'string') {
    return false
  }
  for (const field of ['publishesTo', 'requiredPublishesTo', 'subscribesTo'] as const) {
    if (value[field] !== undefined && !isStringList(value[field])) {
      return false
    }
  }
  if (value.admission === undefined) {
    return true
  }
  if (!isRecord(value.admission) || !isStringList(value.admission.acceptedTypes)) {
    return false
  }
  return (
    value.admission.minPriority === 'normal' ||
    value.admission.minPriority === 'high' ||
    value.admission.minPriority === 'urgent'
  )
}

function isPersistedCollaborationTopology(value: unknown): value is PersistedCollaborationTopology {
  return (
    isRecord(value) &&
    value.version === 1 &&
    Array.isArray(value.steps) &&
    value.steps.every(isPersistedCollaborationStep)
  )
}

function parseCollaborationTopology(runId: string, serialized: string): CollaborationTopology {
  try {
    const parsed: unknown = JSON.parse(serialized)
    if (!isPersistedCollaborationTopology(parsed)) {
      throw new Error('unsupported collaboration topology payload')
    }
    return createCollaborationTopology(parsed.steps)
  } catch (error) {
    throw new OrchestrationError(
      'collaboration_topology_unavailable',
      `Persisted collaboration topology for run ${runId} is invalid: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
