// In-memory generations advance on bind, retirement or rollback, including same-ID respawns; moves/removals do not.

import type { WorkspaceSessionPartitionId } from '../../../../shared/workspace-session/teammate-homes-session-partition'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import type { StoreRuntimeState } from '../store-runtime-state'

type GenerationRuntime = Pick<StoreRuntimeState, 'ptyBindingGenerations'>

const generationKey = (hostId: WorkspaceSessionPartitionId, leafId: string) =>
  `${hostId}\0${leafId}`

export function bumpPtyBindingGeneration(
  runtime: GenerationRuntime,
  hostId: WorkspaceSessionPartitionId,
  leafId: string
): void {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return
  }
  const key = generationKey(hostId, leafId)
  runtime.ptyBindingGenerations.set(key, (runtime.ptyBindingGenerations.get(key) ?? 0) + 1)
}

/** Undefined until this process writes the pane binding. */
export function ptyBindingGenerationOf(
  runtime: GenerationRuntime,
  hostId: WorkspaceSessionPartitionId,
  leafId: string
): number | undefined {
  return runtime.ptyBindingGenerations.get(generationKey(hostId, leafId))
}
