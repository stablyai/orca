import { parsePersistedAutomationHostFilter } from '../../../shared/automation-host-filter'
import { getAutomationRunRepoId } from '../../../shared/automation-run-identity'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration-manifest'
import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'
import { inspectOrcadSourceWorktreeMetadata } from './orcad-source-worktree-metadata'
import {
  ORCAD_MIGRATION_DEPENDENCY_KINDS,
  type OrcadMigrationDependencyKind
} from '../../../shared/orcad-migration-preflight'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { TerminalScrollbackSnapshotStorage } from '../../terminal-scrollback-snapshots'
import { isEmptyRetiredNameRegistry } from '../../../shared/worktree/retired-name-registry'
import { extractRetiredNameRegistriesByNamespace } from '../../orca-profiles/profile-project-retired-name-transfer'
import {
  inspectOrcadMigrationSourceSessions,
  orcadMigrationPaneBelongsToTabs,
  type OrcadMigrationSourceSessionInspection
} from './orcad-source-session-dependencies'
import {
  collectOrcadMigrationSourceDormantState,
  emptyDormantPayload,
  ORCAD_MIGRATION_TRANSFERRED_DORMANT_KINDS
} from './orcad-source-dormant-state'
import {
  createOrcadMigrationSourceScope,
  orcadMigrationOwnerMatchesScope,
  type OrcadMigrationSourceScope
} from './orcad-source-scope'

export type OrcadMigrationSourceDependencyCensus = {
  totalCount: number
  counts: Record<OrcadMigrationDependencyKind, number>
}

export function collectOrcadMigrationSourceDependencyCensus(
  state: PersistedState,
  manifest: OrcadMigrationManifest,
  storage?: TerminalScrollbackSnapshotStorage
): OrcadMigrationSourceDependencyCensus {
  return collectDependencyCensus(state, manifest, false, storage)
}

export function collectOrcadMigrationUntransferredDependencyCensus(
  state: PersistedState,
  manifest: OrcadMigrationManifest,
  storage?: TerminalScrollbackSnapshotStorage
): OrcadMigrationSourceDependencyCensus {
  return collectDependencyCensus(state, manifest, true, storage)
}

function collectDependencyCensus(
  state: PersistedState,
  manifest: OrcadMigrationManifest,
  ignoreTransferredDormantState: boolean,
  storage?: TerminalScrollbackSnapshotStorage
): OrcadMigrationSourceDependencyCensus {
  const scope = createOrcadMigrationSourceScope({
    source: manifest.source,
    catalog: manifest.payload
  })
  const counts: Record<OrcadMigrationDependencyKind, number> = {
    automation: 0,
    'automation-run': 0,
    'mobile-tab-selection': 0,
    'retired-worktree-name': 0,
    'saved-port-forward': 0,
    'sparse-preset': 0,
    'terminal-lease': 0,
    'terminal-recovery': 0,
    'ui-routing': 0,
    'workspace-lineage': 0,
    'workspace-session': 0,
    'worktree-lineage': 0,
    'worktree-metadata': 0
  }
  const target = state.sshTargets.find((entry) => entry.id === scope.targetId)
  counts['saved-port-forward'] = target?.portForwards?.length ?? 0
  counts['terminal-lease'] = state.sshRemotePtyLeases.filter(
    (lease) => lease.targetId === scope.targetId && lease.state !== 'terminated'
  ).length

  const sessions = inspectOrcadMigrationSourceSessions(state, {
    hostId: scope.hostId,
    ownerMatches: (ownerKey) => orcadMigrationOwnerMatchesScope(ownerKey, scope),
    targetId: scope.targetId
  })
  counts['workspace-session'] = sessions.dependencyCount
  counts['terminal-recovery'] = countTerminalRecoveryState(state, scope, sessions)
  const metadata = inspectOrcadSourceWorktreeMetadata(state, scope)
  counts['worktree-metadata'] = metadata.rows.length + metadata.blockedCount
  counts['worktree-lineage'] = Object.entries(state.worktreeLineageById).filter(
    ([ownerKey, lineage]) =>
      orcadMigrationOwnerMatchesScope(ownerKey, scope) ||
      orcadMigrationOwnerMatchesScope(lineage.worktreeId, scope) ||
      orcadMigrationOwnerMatchesScope(lineage.parentWorktreeId, scope)
  ).length
  counts['workspace-lineage'] = Object.entries(state.workspaceLineageByChildKey).filter(
    ([ownerKey, lineage]) =>
      orcadMigrationOwnerMatchesScope(ownerKey, scope) ||
      orcadMigrationOwnerMatchesScope(lineage.childWorkspaceKey, scope) ||
      orcadMigrationOwnerMatchesScope(lineage.parentWorkspaceKey, scope)
  ).length
  counts['sparse-preset'] = [...scope.repoIds].reduce(
    (total, repoId) => total + (state.sparsePresetsByRepo[repoId]?.length ?? 0),
    0
  )
  counts['retired-worktree-name'] = countRetiredWorktreeNameState(state, manifest)

  const blockedAutomationIds = new Set(
    state.automations
      .filter((automation) => automationMatchesScope(automation, scope))
      .map(({ id }) => id)
  )
  counts.automation = blockedAutomationIds.size
  counts['automation-run'] = state.automationRuns.filter(
    (run) =>
      blockedAutomationIds.has(run.automationId) ||
      orcadMigrationOwnerMatchesScope(run.workspaceId, scope) ||
      executionContextMatchesScope(run.runContext, scope) ||
      executionContextMatchesScope(run.sourceContext, scope)
  ).length
  counts['mobile-tab-selection'] = Object.values(
    state.mobileClientTabSelectionsByDeviceId ?? {}
  ).reduce(
    (total, selections) =>
      total +
      Object.keys(selections).filter((ownerKey) => orcadMigrationOwnerMatchesScope(ownerKey, scope))
        .length,
    0
  )
  counts['ui-routing'] = countUiRoutingState(state, scope, sessions)
  const dormant = collectOrcadMigrationSourceDormantState(
    state,
    manifest.source,
    manifest.payload,
    storage,
    manifest.destinationEnvironmentId
  )
  const dormantMatches =
    ignoreTransferredDormantState ||
    serializeOrcadMigrationValue(dormant.payload) ===
      serializeOrcadMigrationValue(manifest.payload.dormantState ?? emptyDormantPayload())
  if (dormantMatches) {
    for (const kind of ORCAD_MIGRATION_TRANSFERRED_DORMANT_KINDS) {
      counts[kind] = dormant.blockedCounts[kind]
    }
  }
  return {
    counts,
    totalCount: ORCAD_MIGRATION_DEPENDENCY_KINDS.reduce((total, kind) => total + counts[kind], 0)
  }
}

function countTerminalRecoveryState(
  state: PersistedState,
  scope: OrcadMigrationSourceScope,
  sessions: OrcadMigrationSourceSessionInspection
): number {
  // Expired routes may still own remote work; only terminated leases resolve recovery authority.
  const hasActiveLease = state.sshRemotePtyLeases.some(
    (lease) => lease.targetId === scope.targetId && lease.state !== 'terminated'
  )
  let count = (state.sshPtyConsumerRecoveries ?? []).filter(
    (recovery) => recovery.targetId === scope.targetId && hasActiveLease
  ).length
  count += state.migrationUnsupportedPtyEntries.filter(
    (entry) =>
      orcadMigrationOwnerMatchesScope(entry.worktreeId, scope) ||
      (entry.tabId ? sessions.tabIds.has(entry.tabId) : false) ||
      sessions.ptyIds.has(entry.ptyId) ||
      (entry.paneKey ? orcadMigrationPaneBelongsToTabs(entry.paneKey, sessions.tabIds) : false)
  ).length
  count += state.legacyPaneKeyAliasEntries.filter(
    (entry) =>
      orcadMigrationPaneBelongsToTabs(entry.legacyPaneKey, sessions.tabIds) ||
      orcadMigrationPaneBelongsToTabs(entry.stablePaneKey, sessions.tabIds)
  ).length
  return count
}

function countRetiredWorktreeNameState(
  state: PersistedState,
  manifest: OrcadMigrationManifest
): number {
  let count = manifest.payload.repositories.filter((repo) => {
    const registry = state.retiredWorktreeNamesByRepo?.[repo.id]
    return registry !== undefined && !isEmptyRetiredNameRegistry(registry)
  }).length
  const namespaceKeys = new Set<string>()
  for (const repo of manifest.payload.repositories) {
    Object.keys(extractRetiredNameRegistriesByNamespace(state, repo)).forEach((key) =>
      namespaceKeys.add(key)
    )
  }
  count += namespaceKeys.size
  return count
}

function automationMatchesScope(
  automation: PersistedState['automations'][number],
  scope: OrcadMigrationSourceScope
): boolean {
  return (
    (automation.executionTargetType === 'ssh' && automation.executionTargetId === scope.targetId) ||
    (scope.targetGeneration !== null &&
      automation.executionTargetGeneration === scope.targetGeneration) ||
    scope.repoIds.has(getAutomationRunRepoId(automation)) ||
    orcadMigrationOwnerMatchesScope(automation.workspaceId, scope) ||
    executionContextMatchesScope(automation.runContext, scope) ||
    executionContextMatchesScope(automation.sourceContext, scope)
  )
}

function executionContextMatchesScope(
  context: { hostId: string; repoId?: string | null } | null | undefined,
  scope: OrcadMigrationSourceScope
): boolean {
  return (
    context?.hostId === scope.hostId ||
    (typeof context?.repoId === 'string' && scope.repoIds.has(context.repoId))
  )
}

function countUiRoutingState(
  state: PersistedState,
  scope: OrcadMigrationSourceScope,
  sessions: OrcadMigrationSourceSessionInspection
): number {
  const ui = state.ui
  let count = ui.lastActiveRepoId && scope.repoIds.has(ui.lastActiveRepoId) ? 1 : 0
  count += orcadMigrationOwnerMatchesScope(ui.lastActiveWorktreeId, scope) ? 1 : 0
  count += ui.filterRepoIds.filter((repoId) => scope.repoIds.has(repoId)).length
  count += Object.keys(ui.showDotfilesByWorktree ?? {}).filter((ownerKey) =>
    orcadMigrationOwnerMatchesScope(ownerKey, scope)
  ).length
  count += (ui.setupScriptPromptDismissedRepoIds ?? []).filter((repoId) =>
    scope.repoIds.has(repoId)
  ).length
  count += (ui.manualRepoOrder ?? []).filter(
    (entry) => entry.hostId === scope.hostId || scope.repoIds.has(entry.repoId)
  ).length
  count += ui.workspaceHostScope === scope.hostId ? 1 : 0
  count += (ui.visibleWorkspaceHostIds ?? []).filter((hostId) => hostId === scope.hostId).length
  count += (ui.workspaceHostOrder ?? []).filter((hostId) => hostId === scope.hostId).length
  const automationFilter = parsePersistedAutomationHostFilter(ui.automationHostFilter)
  count +=
    automationFilter.kind === 'host' &&
    automationFilter.host.authority.kind === 'desktop' &&
    automationFilter.host.selector.kind === 'ssh' &&
    automationFilter.host.selector.targetId === scope.targetId
      ? 1
      : 0
  count += Object.keys(ui.acknowledgedAgentsByPaneKey ?? {}).filter((paneKey) =>
    orcadMigrationPaneBelongsToTabs(paneKey, sessions.tabIds)
  ).length
  return count
}
