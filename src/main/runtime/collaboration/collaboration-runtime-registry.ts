import type { OrcaRuntimeService } from '../orca-runtime'
import type { CollaborationTopology } from './collaboration-topology'

const registrationsByRuntime = new WeakMap<OrcaRuntimeService, Map<string, CollaborationTopology>>()

export function registerCollaborationRuntimeTopology(
  runtime: OrcaRuntimeService,
  runId: string,
  topology: CollaborationTopology
): void {
  let runs = registrationsByRuntime.get(runtime)
  if (!runs) {
    runs = new Map()
    registrationsByRuntime.set(runtime, runs)
  }
  if (runs.has(runId)) {
    throw new Error(`collaboration run ${runId} is already registered`)
  }
  runs.set(runId, topology)
}

export function getCollaborationRuntimeTopology(
  runtime: OrcaRuntimeService,
  runId: string
): CollaborationTopology | undefined {
  return registrationsByRuntime.get(runtime)?.get(runId)
}

export function unregisterCollaborationRuntimeTopology(
  runtime: OrcaRuntimeService,
  runId: string
): void {
  const runs = registrationsByRuntime.get(runtime)
  if (!runs) {
    return
  }
  runs.delete(runId)
  if (runs.size === 0) {
    registrationsByRuntime.delete(runtime)
  }
}
