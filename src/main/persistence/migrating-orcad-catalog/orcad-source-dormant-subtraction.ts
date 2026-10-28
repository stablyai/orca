import type { OrcadMigrationManifest } from '../../../shared/orcad-migration/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { subtractOrcadSourceWorktreeMetadata } from './orcad-source-worktree-metadata'
import { subtractOrcadMigrationSourceAutomationState } from './orcad-source-automation-subtraction'
import { subtractOrcadMigrationSourceWorkspaceSession } from './orcad-source-workspace-session-subtraction'
import { subtractOrcadMigrationClientState } from './orcad-source-client-subtraction'

/** Mutate a delta-view copy only. */
export function subtractOrcadMigrationSourceDormantState(
  state: PersistedState,
  manifest: OrcadMigrationManifest
): void {
  // Include state a downgraded build added even when the manifest had none.
  subtractOrcadSourceWorktreeMetadata(state, manifest)
  subtractOrcadMigrationSourceAutomationState(state, manifest)
  const dormant = manifest.payload.dormantState
  if (!dormant) {
    return
  }
  dormant.worktreeLineage.forEach((entry) => delete state.worktreeLineageById[entry.sourceKey])
  dormant.workspaceLineage.forEach(
    (entry) => delete state.workspaceLineageByChildKey[entry.sourceKey]
  )
  for (const preset of dormant.sparsePresets) {
    const remaining = (state.sparsePresetsByRepo[preset.repoId] ?? []).filter(
      (entry) => entry.id !== preset.id
    )
    if (remaining.length > 0) {
      state.sparsePresetsByRepo[preset.repoId] = remaining
    } else {
      delete state.sparsePresetsByRepo[preset.repoId]
    }
  }
  for (const entry of dormant.retiredWorktreeNames) {
    delete state.retiredWorktreeNamesByRepo?.[entry.repoId]
  }
  subtractOrcadMigrationSourceWorkspaceSession(state, manifest)
  subtractOrcadMigrationClientState(state, manifest)
  // Retain snapshot files: the prior durable profile and rollback evidence can still reference them.
}
