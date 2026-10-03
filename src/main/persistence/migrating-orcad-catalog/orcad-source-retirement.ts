/**
 * The Store's one write for a migrated target: retiring the source rows a destination proved it
 * committed. Idempotent, so a retry after a crash before the journal moved finishes the same work.
 */
import { orcadSourceFolderWorkspaceIds, repoBelongsToOrcadSource } from './orcad-source-ownership'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration-manifest'
import { assertOrcadMigrationManifestDigest } from '../../orcad/orcad-migration-manifest-digest'
import {
  syncProjectHostSetupCompatibilityState,
  type RepoLifecycleOperations
} from '../loading-store/repo-lifecycle-operations'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import { scheduleSave, type WriteSchedulingOperations } from '../loading-store/write-scheduling'
import { retireOrcadSourceCatalogState } from './orcad-source-catalog-retirement'
import {
  assertOrcadMigrationSourceDormantStateRetired,
  retireOrcadMigrationSourceDormantState
} from './orcad-source-dormant-retirement'
import { retireOrcadSourceReconnectHint } from './orcad-source-workspace-session-retirement'

const orcadSourceRetirementContext = Symbol('OrcadSourceRetirementPersistence')
type OrcadSourceRetirementContext = {
  runtime: Pick<StoreRuntimeState, 'state'>
  repos: RepoLifecycleOperations
  scheduling: WriteSchedulingOperations
}

export class OrcadSourceRetirementPersistence {
  readonly [orcadSourceRetirementContext]: OrcadSourceRetirementContext

  constructor(
    runtime: Pick<StoreRuntimeState, 'state'>,
    repos: RepoLifecycleOperations,
    scheduling: WriteSchedulingOperations
  ) {
    this[orcadSourceRetirementContext] = { runtime, repos, scheduling }
  }

  /** The caller holds a journal that proves the destination committed this exact manifest. */
  retireOrcadMigrationSourceCatalog(manifest: OrcadMigrationManifest): void {
    assertOrcadMigrationManifestDigest(manifest)
    const context = this[orcadSourceRetirementContext]
    const state = context.runtime.state
    retireOrcadSourceCatalogState(state, manifest)
    retireOrcadMigrationSourceDormantState(state, manifest)
    retireOrcadSourceReconnectHint(state, manifest.source.sshTargetId)
    syncProjectHostSetupCompatibilityState(context.repos)
    scheduleSave(context.scheduling)
  }

  /** Throws when any row the manifest moved is still, or again, on the source. */
  assertOrcadMigrationSourceRetired(manifest: OrcadMigrationManifest): void {
    const state = this[orcadSourceRetirementContext].runtime.state
    const target = manifest.source.sshTargetId
    const repoIds = new Set(manifest.payload.repositories.map((repo) => repo.id))
    const folderIds = new Set(manifest.payload.folderWorkspaces.map((workspace) => workspace.id))
    const ownedFolderIds = orcadSourceFolderWorkspaceIds(state, target)
    if (
      state.repos.some((repo) => repoIds.has(repo.id) && repoBelongsToOrcadSource(repo, target)) ||
      [...folderIds].some((id) => ownedFolderIds.has(id))
    ) {
      throw new Error('orcad_migration_source_catalog_reappeared')
    }
    assertOrcadMigrationSourceDormantStateRetired(state, manifest)
  }
}

export function installOrcadSourceRetirementPersistenceContext(
  target: OrcadSourceRetirementPersistence,
  source: OrcadSourceRetirementPersistence
): void {
  Object.defineProperty(target, orcadSourceRetirementContext, {
    value: source[orcadSourceRetirementContext]
  })
}
