import { normalizePersistedMobileClientTabSelections } from '../../runtime/client-session-tab-selection-persistence'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import { normalizeFeatureInteractionTelemetryBuckets } from '../../../shared/feature-interactions'
import { normalizeFolderWorkspaceDiffComments } from '../../folder-workspace-diff-comments'
import { normalizeFolderWorkspaces } from '../../../shared/folder-workspaces'
import { normalizeWorkspaceLineageByChildKey } from '../applying-settings/ui-interaction-merge'
import {
  normalizeSshRemotePtyLease,
  normalizeSshTarget
} from '../leasing-ssh-ptys/ssh-normalization'
import {
  normalizeClaudeLivePtySessionIds,
  normalizeLegacyPaneKeyAliasEntries,
  normalizeMigrationUnsupportedPtyEntries
} from '../restoring-sessions/pane-alias-normalization'
import type { PersistedState } from '../../../shared/persisted-state-types'
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
import { normalizeRetiredNameRegistryMap } from './retired-name-registry-normalization'

export function normalizeLoadedProfileState(
  parsed: PersistedState,
  terminal: PreparedLoadedTerminalSettings,
  profile: PreparedLoadedProfileSettings,
  markNeedsSave: () => void
): PersistedState {
  const { defaults, migratedExternalVisibility, osc52ClipboardNoticePending } = terminal
  const { normalizedOnboarding, normalizedProjectGroups, loadedCompactWorktreeCards } = profile
  const projectCatalog = normalizeLoadedProjectCatalog(parsed, markNeedsSave)
  // Ordered: the host partitions drop the global fields this slice already owns.
  const workspaceSession = normalizeLoadedLocalSession(parsed, defaults, markNeedsSave)

  return {
    ...defaults,
    ...parsed,
    featureInteractionTelemetryBuckets: normalizeFeatureInteractionTelemetryBuckets(
      parsed.featureInteractionTelemetryBuckets
    ),
    projectGroups: normalizedProjectGroups,
    repos: migratedExternalVisibility.repos,
    // Why: persisted catalog rows are untrusted JSON; consumers call string methods on fields the type says are strings.
    projects: projectCatalog.projects,
    projectHostSetups: projectCatalog.projectHostSetups,
    folderWorkspaces: normalizeFolderWorkspaces(parsed.folderWorkspaces, normalizedProjectGroups),
    folderWorkspaceDiffComments: normalizeFolderWorkspaceDiffComments(
      parsed.folderWorkspaceDiffComments
    ),
    worktreeLineageById: parsed.worktreeLineageById ?? {},
    mobileClientTabSelectionsByDeviceId: normalizePersistedMobileClientTabSelections(
      parsed.mobileClientTabSelectionsByDeviceId
    ),
    workspaceLineageByChildKey: normalizeWorkspaceLineageByChildKey(
      parsed.workspaceLineageByChildKey
    ),
    settings: normalizeLoadedGlobalSettings(parsed, terminal, profile),
    // Why: legacy 'recent' meant the smart sort; migrate once on the raw value so a fresh 'recent' default isn't remigrated.
    ui: normalizeLoadedUiState(
      parsed,
      defaults,
      normalizedOnboarding,
      loadedCompactWorktreeCards,
      osc52ClipboardNoticePending,
      markNeedsSave
    ),
    // Why: volatile schema; zod-validate workspaceSession at read so a bad payload falls to defaults, not a renderer crash.
    workspaceSession,
    // Why: per-host session partitions, validated independently; 'local' stays in workspaceSession for downgrade compat.
    workspaceSessionsByHostId: normalizeLoadedHostSessions(
      parsed,
      defaults,
      workspaceSession,
      markNeedsSave
    ),
    sshTargets: (parsed.sshTargets ?? []).map(normalizeSshTarget),
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
    claudeLivePtySessionIds: normalizeClaudeLivePtySessionIds(parsed.claudeLivePtySessionIds),
    migrationUnsupportedPtyEntries: normalizeMigrationUnsupportedPtyEntries(
      parsed.migrationUnsupportedPtyEntries
    ),
    legacyPaneKeyAliasEntries: normalizeLegacyPaneKeyAliasEntries(parsed.legacyPaneKeyAliasEntries),
    automations: Array.isArray(parsed.automations) ? parsed.automations : [],
    automationRuns: normalizeLoadedAutomationRuns(parsed, markNeedsSave),
    onboarding: normalizedOnboarding
  }
}
