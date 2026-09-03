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

function parseCollaborationTopology(runId: string, serialized: string): CollaborationTopology {
  try {
    const parsed = JSON.parse(serialized) as Partial<PersistedCollaborationTopology> | null
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.steps)) {
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
