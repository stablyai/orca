import { normalizePersistedMobileClientTabSelections } from '../../../runtime/client/navigation/client-session-tab-selection-persistence'
import type { SshRemotePtyLease } from '../../../../shared/ssh-types'
import { normalizeFeatureInteractionTelemetryBuckets } from '../../../../shared/feature-interactions'
import { normalizeFolderWorkspaceDiffComments } from '../../../workspaces/catalog/folder-workspace-diff-comments'
import { normalizeFolderWorkspaces } from '../../../../shared/folder-workspaces/folder-workspaces'
import { normalizeOrcadMigrationEvictedReceipts } from '../../../../shared/orcad-migration/orcad-migration-evicted-receipts'
import { normalizeOrcadMigrationImportReceipts } from '../../../../shared/orcad-migration/orcad-migration-manifest-validation'
import { normalizeOrcadMigrationStagedCatalogs } from '../../../../shared/orcad-migration/orcad-migration-staged-catalog-validation'
import { normalizeWorkspaceLineageByChildKey } from '../../applying-settings/ui-interaction-merge'
import { dropInferredParentsOverFolderParents } from '../workspace-lineage/folder-parent-lineage-persistence'
import { normalizeCrossStoreLineageByChildKey } from '../../../../shared/worktree/lineage/cross-store-lineage-records'
import {
  normalizeSshRemotePtyLease,
  normalizeSshTarget
} from '../../leasing-ssh-ptys/ssh-normalization'
import { migrateExistingHostsRemoteCliControl } from '../../leasing-ssh-ptys/ssh-remote-cli-control-migration'
import { migrateExistingReposAgentWorkspaceTrust } from '../../tracking-repos/agent-workspace-trust-existing-repos-migration'
import {
  normalizeLegacyPaneKeyAliasEntries,
  normalizeMigrationUnsupportedPtyEntries
} from '../../restoring-sessions/pane-alias-normalization'
import type { PersistedState } from '../../../../shared/persisted-state-types'
import type { PreparedLoadedTerminalSettings } from './prepare-loaded-terminal-settings'
import type { PreparedLoadedProfileSettings } from './prepare-loaded-profile-settings'
import { normalizeLoadedGlobalSettings } from './normalize-loaded-global-settings'
import { normalizeLoadedUiState } from './normalize-loaded-ui-state'
import {
  normalizeLoadedAutomationRuns,
  normalizeLoadedHostSessions,
  normalizeLoadedLocalSession,
  normalizeLoadedProjectCatalog
} from './normalize-loaded-state-collections'
import { normalizeRetiredNameRegistryMap } from '../project-catalog/retired-name-registry-normalization'
import { hydrateWorktreeMetaAliasProjection } from '../worktree-metadata/worktree-meta-alias-projection'

export function normalizeLoadedProfileState(
  parsed: PersistedState,
  terminal: PreparedLoadedTerminalSettings,
  profile: PreparedLoadedProfileSettings,
  markNeedsSave: () => void
): PersistedState {
  const { defaults, migratedExternalVisibility, osc52ClipboardNoticePending } = terminal
  const { normalizedOnboarding, normalizedProjectGroups, loadedCompactWorktreeCards } = profile
  const projectCatalog = normalizeLoadedProjectCatalog(parsed, markNeedsSave)
  // Normalize local first; host partitions drop global fields already owned here.
  const workspaceSession = normalizeLoadedLocalSession(parsed, defaults, markNeedsSave)
  const workspaceLineageByChildKey = normalizeWorkspaceLineageByChildKey(
    parsed.workspaceLineageByChildKey
  )
  const worktreeLineageById = { ...parsed.worktreeLineageById }
  dropInferredParentsOverFolderParents(worktreeLineageById, workspaceLineageByChildKey)

  return {
    ...defaults,
    ...parsed,
    featureInteractionTelemetryBuckets: normalizeFeatureInteractionTelemetryBuckets(
      parsed.featureInteractionTelemetryBuckets
    ),
    projectGroups: normalizedProjectGroups,
    repos: migrateExistingReposAgentWorkspaceTrust(
      migratedExternalVisibility.repos,
      parsed.settings,
      markNeedsSave
    ),
    projects: projectCatalog.projects,
    projectHostSetups: projectCatalog.projectHostSetups,
    folderWorkspaces: normalizeFolderWorkspaces(parsed.folderWorkspaces, normalizedProjectGroups),
    folderWorkspaceDiffComments: normalizeFolderWorkspaceDiffComments(
      parsed.folderWorkspaceDiffComments
    ),
    // Rehydrate canonical aliases/shared references omitted by serialization; absence stays absent.
    ...(parsed.worktreeMetaByIdentity === undefined
      ? {}
      : { worktreeMetaByIdentity: hydrateWorktreeMetaAliasProjection(parsed) }),
    worktreeLineageById,
    mobileClientTabSelectionsByDeviceId: normalizePersistedMobileClientTabSelections(
      parsed.mobileClientTabSelectionsByDeviceId
    ),
    workspaceLineageByChildKey,
    crossStoreLineageByChildKey: normalizeCrossStoreLineageByChildKey(
      parsed.crossStoreLineageByChildKey
    ),
    settings: normalizeLoadedGlobalSettings(parsed, terminal, profile),
    ui: normalizeLoadedUiState(
      parsed,
      defaults,
      normalizedOnboarding,
      loadedCompactWorktreeCards,
      osc52ClipboardNoticePending,
      markNeedsSave
    ),
    workspaceSession,
    // Keep local in workspaceSession for downgrade compatibility; validate other hosts independently.
    workspaceSessionsByHostId: normalizeLoadedHostSessions(
      parsed,
      defaults,
      workspaceSession,
      markNeedsSave
    ),
    sshTargets: migrateExistingHostsRemoteCliControl(
      (parsed.sshTargets ?? []).map(normalizeSshTarget),
      parsed.settings?.sshRemoteCliControlExistingHostsMigrated === true,
      markNeedsSave
    ),
    deletedSshConfigAliases: Array.isArray(parsed.deletedSshConfigAliases)
      ? parsed.deletedSshConfigAliases.filter((alias): alias is string => typeof alias === 'string')
      : [],
    retiredWorktreeNamesByRepo: normalizeRetiredNameRegistryMap(parsed.retiredWorktreeNamesByRepo),
    retiredWorktreeNamesByNamespace: normalizeRetiredNameRegistryMap(
      parsed.retiredWorktreeNamesByNamespace
    ),
    sshRemotePtyLeases: (parsed.sshRemotePtyLeases ?? [])
      .map(normalizeSshRemotePtyLease)
      .filter((lease): lease is SshRemotePtyLease => lease !== null),
    sshPtyConsumerRecoveries: parsed.sshPtyConsumerRecoveries,
    migrationUnsupportedPtyEntries: normalizeMigrationUnsupportedPtyEntries(
      parsed.migrationUnsupportedPtyEntries
    ),
    legacyPaneKeyAliasEntries: normalizeLegacyPaneKeyAliasEntries(parsed.legacyPaneKeyAliasEntries),
    automations: Array.isArray(parsed.automations) ? parsed.automations : [],
    automationRuns: normalizeLoadedAutomationRuns(parsed, markNeedsSave),
    orcadMigrationImportReceipts: normalizeOrcadMigrationImportReceipts(
      parsed.orcadMigrationImportReceipts
    ),
    orcadMigrationEvictedReceipts: normalizeOrcadMigrationEvictedReceipts(
      parsed.orcadMigrationEvictedReceipts
    ),
    orcadMigrationStagedCatalogs: normalizeOrcadMigrationStagedCatalogs(
      parsed.orcadMigrationStagedCatalogs
    ),
    onboarding: normalizedOnboarding
  }
}
