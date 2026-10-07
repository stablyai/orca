/**
 * The source as a delta move sees it: a copy of the profile with everything earlier migrations of
 * the host already moved subtracted from it. What is left is what an older build added, and only
 * that is exported, censused and later committed.
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
import { subtractOrcadSourceCatalogState } from './orcad-source-catalog-subtraction'
import {
  collectOrcadMigrationUntransferredDependencyCensus,
  type OrcadMigrationSourceDependencyCensus
} from './orcad-source-dependency-census'
import { subtractOrcadMigrationSourceDormantState } from './orcad-source-dormant-subtraction'
import { collectOrcadMigrationSourceDormantState } from './orcad-source-dormant-state'
import { subtractOrcadMigrationScopeWorkspaceSession } from './orcad-source-workspace-session-subtraction'

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
  subtractOrcadSourceCatalogState(state, moved)
  subtractOrcadMigrationSourceDormantState(state, moved)
  // The server owns the moved projects' tabs now, even ones the older build left unmovable.
  subtractOrcadMigrationScopeWorkspaceSession(state, moved)
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
