/**
 * The source as a delta move sees it: a copy of the profile with everything earlier migrations of
 * the host already moved retired from it, the same way source retirement would. What is left is
 * what an older build added, and only that is exported, censused and later committed.
 */
import type {
  OrcadMigrationCatalogPayload,
  OrcadMigrationDormantStatePayload,
  OrcadMigrationManifest,
  OrcadMigrationManifestSource
} from '../../../shared/orcad-migration-manifest'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import { retireOrcadSourceCatalogState } from './orcad-source-catalog-retirement'
import {
  collectOrcadMigrationUntransferredDependencyCensus,
  type OrcadMigrationSourceDependencyCensus
} from './orcad-source-dependency-census'
import { retireOrcadMigrationSourceDormantState } from './orcad-source-dormant-retirement'
import { collectOrcadMigrationSourceDormantState } from './orcad-source-dormant-state'

export type OrcadMigrationDeltaView = {
  getRepos: () => Repo[]
  getFolderWorkspaces: () => FolderWorkspace[]
  getProjectGroups: () => ProjectGroup[]
  collectOrcadMigrationSourceDormantState: (
    source: OrcadMigrationManifestSource,
    catalog: OrcadMigrationCatalogPayload,
    destinationEnvironmentId?: string
  ) => OrcadMigrationDormantStatePayload
  inspectOrcadMigrationUntransferredDependencies: (
    manifest: OrcadMigrationManifest
  ) => OrcadMigrationSourceDependencyCensus
}

/** `moved` re-exports what the earlier migrations own today, including later edits to it. */
export function createOrcadMigrationDeltaView(
  runtime: Pick<StoreRuntimeState, 'state' | 'terminalScrollbackSnapshotStorage'>,
  moved: OrcadMigrationManifest
): OrcadMigrationDeltaView {
  const state = structuredClone(runtime.state)
  retireOrcadSourceCatalogState(state, moved)
  retireOrcadMigrationSourceDormantState(state, moved)
  const storage = runtime.terminalScrollbackSnapshotStorage
  return {
    getRepos: () => state.repos,
    getFolderWorkspaces: () => state.folderWorkspaces,
    getProjectGroups: () => state.projectGroups,
    collectOrcadMigrationSourceDormantState: (source, catalog, destinationEnvironmentId) =>
      collectOrcadMigrationSourceDormantState(
        state,
        source,
        catalog,
        storage,
        destinationEnvironmentId
      ).payload,
    inspectOrcadMigrationUntransferredDependencies: (manifest) =>
      collectOrcadMigrationUntransferredDependencyCensus(state, manifest, storage)
  }
}
