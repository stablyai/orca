import type { OrcadMigrationManifest } from '../../../shared/orcad-migration/orcad-migration-manifest'
import {
  ORCAD_MIGRATION_DEPENDENCY_KINDS,
  type OrcadMigrationDependencyKind
} from '../../../shared/orcad-migration/orcad-migration-preflight'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { TerminalScrollbackSnapshotStorage } from '../../terminal-scrollback-snapshots'
import {
  inspectOrcadMigrationSourceSessions,
  type OrcadMigrationSourceSessionInspection
} from './orcad-source-session-dependencies'
import {
  collectOrcadMigrationSourceDormantState,
  orcadMigrationLeavesBehind
} from './orcad-source-dormant-state'
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
  /** Blocker names and remedies where available. */
  names?: Partial<Record<OrcadMigrationDependencyKind, string[]>>
}

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
    // Retained recoveries can stay behind; the terminal gate still requires exit.
    'terminal-recovery': orcadMigrationLeavesBehind(state, scope.targetId)
      ? 0
      : countTerminalRecoveryState(state, scope, sessions)
  }
  return {
    counts,
    totalCount: ORCAD_MIGRATION_DEPENDENCY_KINDS.reduce((total, kind) => total + counts[kind], 0),
    names: {
      ...(dormant.blockedSessionItems.length > 0
        ? { 'workspace-session': dormant.blockedSessionItems }
        : {}),
      ...(dormant.runningAutomationItems.length > 0
        ? { 'automation-run': dormant.runningAutomationItems }
        : {})
    }
  }
}

// The terminal gate proves recovery leases exited; hook aliases add no independent terminal ownership.
function countTerminalRecoveryState(
  state: PersistedState,
  scope: OrcadMigrationSourceScope,
  sessions: OrcadMigrationSourceSessionInspection
): number {
  return state.migrationUnsupportedPtyEntries.filter(
    (entry) =>
      orcadMigrationOwnerMatchesScope(entry.worktreeId, scope) ||
      (entry.tabId ? sessions.tabIds.has(entry.tabId) : false) ||
      sessions.ptyIds.has(entry.ptyId) ||
      (entry.paneKey ? paneBelongsToTabs(entry.paneKey, sessions.tabIds) : false)
  ).length
}
