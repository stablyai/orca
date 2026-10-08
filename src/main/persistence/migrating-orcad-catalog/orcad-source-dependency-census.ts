import type { OrcadMigrationManifest } from '../../../shared/orcad-migration-manifest'
import {
  ORCAD_MIGRATION_DEPENDENCY_KINDS,
  type OrcadMigrationDependencyKind
} from '../../../shared/orcad-migration-preflight'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { TerminalScrollbackSnapshotStorage } from '../../terminal-scrollback-snapshots'
import {
  inspectOrcadMigrationSourceSessions,
  type OrcadMigrationSourceSessionInspection
} from './orcad-source-session-dependencies'
import { collectOrcadMigrationSourceDormantState } from './orcad-source-dormant-state'
import {
  createOrcadMigrationSourceScope,
  orcadMigrationOwnerMatchesScope,
  orcadMigrationPartitionScope,
  type OrcadMigrationSourceScope
} from './orcad-source-scope'
import { paneBelongsToTabs } from '../../../shared/workspace-session-pane-ownership'

export type OrcadMigrationSourceDependencyCensus = {
  totalCount: number
  counts: Record<OrcadMigrationDependencyKind, number>
}

/** What still references the target that this manifest cannot carry. */
export function collectOrcadMigrationUntransferredDependencyCensus(
  state: PersistedState,
  manifest: OrcadMigrationManifest,
  storage?: TerminalScrollbackSnapshotStorage
): OrcadMigrationSourceDependencyCensus {
  const scope = createOrcadMigrationSourceScope({
    source: manifest.source,
    catalog: manifest.payload,
    repos: state.repos
  })
  const sessions = inspectOrcadMigrationSourceSessions(state, {
    hostId: scope.hostId,
    ownerMatches: (ownerKey, partitionHostId) =>
      orcadMigrationOwnerMatchesScope(
        ownerKey,
        orcadMigrationPartitionScope(scope, partitionHostId)
      )
  })
  const dormant = collectOrcadMigrationSourceDormantState(
    state,
    manifest.source,
    manifest.payload,
    storage,
    manifest.destinationEnvironmentId
  )
  const counts: Record<OrcadMigrationDependencyKind, number> = {
    ...dormant.blockedCounts,
    'terminal-lease': state.sshRemotePtyLeases.filter(
      (lease) => lease.targetId === scope.targetId && lease.state !== 'terminated'
    ).length,
    'terminal-recovery': countTerminalRecoveryState(state, scope, sessions)
  }
  return {
    counts,
    totalCount: ORCAD_MIGRATION_DEPENDENCY_KINDS.reduce((total, kind) => total + counts[kind], 0)
  }
}

// Consumer recoveries never block: the terminal gate proves before every move that their leases exited.
function countTerminalRecoveryState(
  state: PersistedState,
  scope: OrcadMigrationSourceScope,
  sessions: OrcadMigrationSourceSessionInspection
): number {
  const unsupported = state.migrationUnsupportedPtyEntries.filter(
    (entry) =>
      orcadMigrationOwnerMatchesScope(entry.worktreeId, scope) ||
      (entry.tabId ? sessions.tabIds.has(entry.tabId) : false) ||
      sessions.ptyIds.has(entry.ptyId) ||
      (entry.paneKey ? paneBelongsToTabs(entry.paneKey, sessions.tabIds) : false)
  ).length
  const aliases = state.legacyPaneKeyAliasEntries.filter(
    (entry) =>
      paneBelongsToTabs(entry.legacyPaneKey, sessions.tabIds) ||
      paneBelongsToTabs(entry.stablePaneKey, sessions.tabIds)
  ).length
  return unsupported + aliases
}
