import type { OrcadMigrationManifest } from '../../../shared/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { isEmptyRetiredNameRegistry } from '../../../shared/worktree/retired-name-registry'
import {
  assertOrcadSourceWorktreeMetadataRetired,
  retireOrcadSourceWorktreeMetadata
} from './orcad-source-worktree-metadata'
import {
  assertOrcadMigrationSourceAutomationStateRetired,
  retireOrcadMigrationSourceAutomationState
} from './orcad-source-automation-state'
import {
  assertOrcadMigrationSourceWorkspaceSessionRetired,
  retireOrcadMigrationSourceWorkspaceSession
} from './orcad-source-workspace-session'
import {
  assertOrcadMigrationClientStateRetired,
  retireOrcadMigrationClientState
} from './orcad-source-client-retirement'

export function assertOrcadMigrationSourceDormantStateRetired(
  state: PersistedState,
  manifest: OrcadMigrationManifest
): void {
  const dormant = manifest.payload.dormantState
  if (!dormant) {
    return
  }
  const hasRows =
    dormant.worktreeMeta.some((entry) => state.worktreeMeta[entry.sourceKey] !== undefined) ||
    dormant.worktreeLineage.some(
      (entry) => state.worktreeLineageById[entry.sourceKey] !== undefined
    ) ||
    dormant.workspaceLineage.some(
      (entry) => state.workspaceLineageByChildKey[entry.sourceKey] !== undefined
    ) ||
    dormant.sparsePresets.some((preset) =>
      state.sparsePresetsByRepo[preset.repoId]?.some((entry) => entry.id === preset.id)
    ) ||
    dormant.retiredWorktreeNames.some((entry) => {
      const registry = state.retiredWorktreeNamesByRepo?.[entry.repoId]
      return registry !== undefined && !isEmptyRetiredNameRegistry(registry)
    })
  if (hasRows) {
    throw new Error('orcad_migration_source_dormant_state_reappeared')
  }
  assertOrcadSourceWorktreeMetadataRetired(state, manifest)
  assertOrcadMigrationSourceWorkspaceSessionRetired(state, manifest)
  assertOrcadMigrationSourceAutomationStateRetired(state, manifest)
  assertOrcadMigrationClientStateRetired(state, manifest)
}

export function retireOrcadMigrationSourceDormantState(
  state: PersistedState,
  manifest: OrcadMigrationManifest
): void {
  const dormant = manifest.payload.dormantState
  if (!dormant) {
    return
  }
  retireOrcadSourceWorktreeMetadata(state, manifest)
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
  retireOrcadMigrationSourceWorkspaceSession(state, manifest)
  retireOrcadMigrationSourceAutomationState(state, manifest)
  retireOrcadMigrationClientState(state, manifest)
  // Retain snapshot files: the prior durable profile and rollback evidence can still reference them.
}
