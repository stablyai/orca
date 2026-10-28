// Offer "Move anyway" only when a consent-free preview shows it clears the blockers.
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import { collectOrcadMigrationUntransferredDependencyCensus } from './orcad-source-dependency-census'
import { collectOrcadMigrationSourceDormantState } from './orcad-source-dormant-state'
import type { OrcadMigrationDeltaView } from './orcad-source-delta-view'

export function createOrcadMigrationLeaveBehindView(
  runtime: Pick<StoreRuntimeState, 'state' | 'terminalScrollbackSnapshotStorage'>,
  targetId: string
): OrcadMigrationDeltaView {
  // Read-only collectors make a shallow copy sufficient.
  const state = {
    ...runtime.state,
    sshTargets: runtime.state.sshTargets.map((target) =>
      target.id === targetId
        ? { ...target, managedServerLeaveBehind: { confirmedAt: new Date(0).toISOString() } }
        : target
    )
  }
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
