import {
  serializeOrcadMigrationValue,
  type OrcadMigrationCatalogState,
  type OrcadMigrationManifest
} from '../../../shared/orcad-migration-manifest'
import { parseOrcadMigrationSourceCutover } from '../../../shared/orcad-migration-source-cutover'
import { getManagedOrcadOwnerEnvironmentId } from '../../../shared/managed-orcad-ssh-owner'
import type { ProjectCollectionOperations } from '../loading-store/project-collection-operations'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import { scheduleSave } from '../loading-store/write-scheduling'
import { collectOrcadMigrationSourceCatalog } from './orcad-source-catalog'
import { assertOrcadMigrationSourceDormantStateRetired } from './orcad-source-dormant-state'
import {
  collectOrcadMigrationSourceDependencyCensus,
  collectOrcadMigrationUntransferredDependencyCensus
} from './orcad-source-dependency-census'
import type { OrcadMigrationSourceCutover } from '../../../shared/orcad-migration-source-cutover'
import type {
  OrcadSourceCutoverContext,
  OrcadSourceCutoverRuntime
} from './orcad-source-cutover-context'

export function assertSourceCatalogRetired(
  state: StoreRuntimeState['state'],
  manifest: OrcadMigrationManifest
): void {
  const repoIds = new Set(manifest.payload.repositories.map((repo) => repo.id))
  if (
    state.repos.some(
      (repo) => repoIds.has(repo.id) && repo.connectionId === manifest.source.sshTargetId
    )
  ) {
    throw new Error('orcad_migration_source_catalog_reappeared')
  }
  const folderIds = new Set(manifest.payload.folderWorkspaces.map((workspace) => workspace.id))
  const groupConnectionById = new Map(
    state.projectGroups.map((group) => [group.id, group.connectionId])
  )
  if (
    state.folderWorkspaces.some(
      (workspace) =>
        folderIds.has(workspace.id) &&
        (workspace.connectionId ?? groupConnectionById.get(workspace.projectGroupId) ?? null) ===
          manifest.source.sshTargetId
    )
  ) {
    throw new Error('orcad_migration_source_catalog_reappeared')
  }
}

export function assertSourceDependenciesAbsent(
  runtime: OrcadSourceCutoverRuntime,
  manifest: OrcadMigrationManifest
): void {
  if (
    collectOrcadMigrationSourceDependencyCensus(
      runtime.state,
      manifest,
      runtime.terminalScrollbackSnapshotStorage
    ).totalCount > 0
  ) {
    throw new Error('orcad_migration_source_dependencies_present')
  }
}

export function assertSourceDependenciesRetired(
  runtime: OrcadSourceCutoverRuntime,
  manifest: OrcadMigrationManifest
): void {
  assertOrcadMigrationSourceDormantStateRetired(runtime.state, manifest)
  if (
    collectOrcadMigrationUntransferredDependencyCensus(
      runtime.state,
      manifest,
      runtime.terminalScrollbackSnapshotStorage
    ).totalCount > 0
  ) {
    throw new Error('orcad_migration_source_dependencies_present')
  }
}

export function assertSourceTargetIdentity(
  target: { id: string; label: string; generation?: number },
  manifest: OrcadMigrationManifest
): void {
  if (
    target.id !== manifest.source.sshTargetId ||
    target.label !== manifest.source.targetLabel ||
    (target.generation ?? null) !== manifest.source.sshTargetGeneration
  ) {
    throw new Error('orcad_migration_source_target_identity_changed')
  }
}

export function assertSourceCatalogUnchanged(
  projects: Pick<
    ProjectCollectionOperations,
    'getFolderWorkspaces' | 'getProjectGroups' | 'getRepos'
  >,
  manifest: OrcadMigrationManifest
): void {
  const payload = collectOrcadMigrationSourceCatalog(projects, {
    id: manifest.source.sshTargetId
  })
  const { dormantState: _dormantState, ...manifestCatalog } = manifest.payload
  if (serializeOrcadMigrationValue(payload) !== serializeOrcadMigrationValue(manifestCatalog)) {
    throw new Error('orcad_migration_source_catalog_changed')
  }
}

export function requireSourceFence(
  state: StoreRuntimeState['state'],
  cutover: OrcadMigrationSourceCutover
): StoreRuntimeState['state']['sshTargets'][number] {
  const target = state.sshTargets.find((entry) => entry.id === cutover.manifest.source.sshTargetId)
  if (
    !target ||
    getManagedOrcadOwnerEnvironmentId(target.owner) !== cutover.destinationEnvironmentId
  ) {
    throw new Error('orcad_migration_source_fence_lost')
  }
  return target
}

export function assertSameCutover(
  current: OrcadMigrationSourceCutover,
  manifest: OrcadMigrationManifest,
  destinationEnvironmentId: string,
  destinationName: string | undefined
): void {
  if (
    current.manifest.manifestSha256 !== manifest.manifestSha256 ||
    current.destinationEnvironmentId !== destinationEnvironmentId ||
    (destinationName !== undefined &&
      current.destinationName !== undefined &&
      current.destinationName !== destinationName)
  ) {
    throw new Error('orcad_migration_source_cutover_identity_conflict')
  }
}

export function assertDestinationStateIdentity(
  cutover: OrcadMigrationSourceCutover,
  destinationState: OrcadMigrationCatalogState
): void {
  if (
    destinationState.migrationId !== cutover.manifest.migrationId ||
    destinationState.manifestSha256 !== cutover.manifest.manifestSha256
  ) {
    throw new Error('orcad_migration_destination_state_identity_mismatch')
  }
}

export function findCutover(
  state: StoreRuntimeState['state'],
  migrationId: string
): OrcadMigrationSourceCutover | undefined {
  return state.orcadMigrationSourceCutovers?.find(
    (entry) => entry.manifest.migrationId === migrationId
  )
}

export function requireCutover(
  state: StoreRuntimeState['state'],
  migrationId: string
): OrcadMigrationSourceCutover {
  const cutover = findCutover(state, migrationId)
  if (!cutover) {
    throw new Error('orcad_migration_source_cutover_not_found')
  }
  if (cutover.version === 2) {
    throw new Error('orcad_migration_live_cutover_coordinator_required')
  }
  return cutover
}

export function replaceCutover(
  context: OrcadSourceCutoverContext,
  next: OrcadMigrationSourceCutover
): OrcadMigrationSourceCutover {
  const parsed = parseOrcadMigrationSourceCutover(next)
  context.runtime.state.orcadMigrationSourceCutovers = (
    context.runtime.state.orcadMigrationSourceCutovers ?? []
  ).map((entry) => (entry.manifest.migrationId === parsed.manifest.migrationId ? parsed : entry))
  scheduleSave(context.scheduling)
  return parsed
}
