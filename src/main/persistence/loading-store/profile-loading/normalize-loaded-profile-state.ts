import { decodeSavedLocalPtyReference } from '../../restoring-sessions/saved-local-terminal-ids'
import { normalizePersistedMobileClientTabSelections } from '../../../runtime/client/navigation/client-session-tab-selection-persistence'
import type { SshRemotePtyLease } from '../../../../shared/remote-runtime/ssh/ssh-types'
import { normalizeFeatureInteractionTelemetryBuckets } from '../../../../shared/feature-education/interactions/feature-interactions'
import { normalizeFolderWorkspaceDiffComments } from '../../../workspaces/catalog/folder-workspace-diff-comments'
import { normalizeFolderWorkspaces } from '../../../../shared/folder-workspaces/folder-workspaces'
import { normalizeOrcadMigrationEvictedReceipts } from '../../../../shared/orcad-migration/orcad-migration-evicted-receipts'
import { normalizeOrcadMigrationImportReceipts } from '../../../../shared/orcad-migration/orcad-migration-manifest-validation'
import { normalizeOrcadMigrationStagedCatalogs } from '../../../../shared/orcad-migration/orcad-migration-staged-catalog-validation'
import { normalizeWorkspaceLineageByChildKey } from '../../applying-settings/ui-interaction-merge'
import { dropInferredParentsOverFolderParents } from '../workspace-lineage/folder-parent-lineage-persistence'
import { normalizeCrossStoreLineageByChildKey } from '../../../../shared/worktree/lineage/cross-store-lineage-records'
import { normalizePersistedBots, splitBotsByOlderBuildSupport } from '../../../../shared/bot-types'
import { migrateRetiredBotAgent } from '../../../../shared/bots/bot-retired-agents'
import {
  markImmutableBotSnapshot,
  orderBotsBySavedOrder
} from '../../../../shared/bots/bot-lookup-index'
import { withBotAutomationAgents } from '../../../bots/bot-automation-agent-sync'
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
import type { PersistedState } from '../../../../shared/orca-profiles/persisted-state-types'
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
  const {
    normalizedOnboarding,
    normalizedProjectGroups,
    normalizedCollections,
    loadedCompactWorktreeCards
  } = profile
  const projectCatalog = normalizeLoadedProjectCatalog(parsed, markNeedsSave)
  // Normalize local first; host partitions drop global fields already owned here.
  const workspaceSession = normalizeLoadedLocalSession(parsed, defaults, markNeedsSave)
  const parsedBotOrder = Array.isArray(parsed.botOrder)
    ? parsed.botOrder.filter((id): id is string => typeof id === 'string')
    : undefined
  const savedBots = [
    ...(Array.isArray(parsed.bots) ? parsed.bots : []),
    ...(Array.isArray(parsed.botsNewerAgents) ? parsed.botsNewerAgents : [])
  ]
  const normalizedBots =
    parsed.bots === undefined && parsed.botsNewerAgents === undefined
      ? undefined
      : normalizePersistedBots(savedBots)
  // Saved Gemini CLI bots load as Antigravity bots; save once so the switch is on disk.
  if (savedBots.some((bot) => migrateRetiredBotAgent(bot) !== bot)) {
    markNeedsSave()
  }
  const allBots =
    normalizedBots && parsedBotOrder
      ? orderBotsBySavedOrder(normalizedBots, parsedBotOrder)
      : normalizedBots
  const { readable: bots, newer: botsNewerAgents } = allBots
    ? splitBotsByOlderBuildSupport(allBots)
    : { readable: undefined, newer: [] }
  if (bots) {
    markImmutableBotSnapshot(bots)
  }
  const hasStaleNewerBotState =
    botsNewerAgents.length === 0 &&
    (parsed.botsNewerAgents !== undefined || parsed.botOrder !== undefined)
  if (
    hasStaleNewerBotState ||
    (botsNewerAgents.length > 0 && parsed.bots?.length !== bots?.length)
  ) {
    markNeedsSave()
  }
  if (allBots !== undefined && parsed.botsPermissionDefaultMigrated !== true) {
    // Old bots were created with Ask; later explicit Ask overrides must survive reloads.
    for (const bot of allBots) {
      if (bot.permissionMode === 'ask') {
        delete bot.permissionMode
      }
    }
    markNeedsSave()
  }
  const workspaceLineageByChildKey = normalizeWorkspaceLineageByChildKey(
    parsed.workspaceLineageByChildKey
  )
  const worktreeLineageById = { ...parsed.worktreeLineageById }
  dropInferredParentsOverFolderParents(worktreeLineageById, workspaceLineageByChildKey)

  const legacyPaneKeyAliasEntries = normalizeLegacyPaneKeyAliasEntries(
    parsed.legacyPaneKeyAliasEntries
  ).map((entry) => {
    const decoded = decodeSavedLocalPtyReference(entry)
    if (decoded !== entry) {
      markNeedsSave()
    }
    return decoded
  })
  const migrationUnsupportedPtyEntries = normalizeMigrationUnsupportedPtyEntries(
    parsed.migrationUnsupportedPtyEntries
  ).map((entry) => {
    const decoded = entry.source === 'local' ? decodeSavedLocalPtyReference(entry) : entry
    if (decoded !== entry) {
      markNeedsSave()
    }
    return decoded
  })

  const {
    botsNewerAgents: _parsedBotsNewerAgents,
    botOrder: _parsedBotOrder,
    ...restParsed
  } = parsed

  return {
    ...defaults,
    ...restParsed,
    featureInteractionTelemetryBuckets: normalizeFeatureInteractionTelemetryBuckets(
      parsed.featureInteractionTelemetryBuckets
    ),
    projectGroups: normalizedProjectGroups,
    collections: normalizedCollections,
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
    migrationUnsupportedPtyEntries,
    legacyPaneKeyAliasEntries,
    // Bots that switched agents before their automations followed: those catch up once.
    automations: withBotAutomationAgents(
      Array.isArray(parsed.automations) ? parsed.automations : [],
      allBots ?? [],
      markNeedsSave
    ),
    automationRuns: normalizeLoadedAutomationRuns(parsed, markNeedsSave),
    ...(bots === undefined
      ? {}
      : {
          bots,
          botsPermissionDefaultMigrated: true as const,
          ...(botsNewerAgents.length > 0
            ? {
                botsNewerAgents: markImmutableBotSnapshot(botsNewerAgents),
                botOrder: markImmutableBotSnapshot(
                  parsedBotOrder ?? (allBots ?? []).map((bot) => bot.id)
                )
              }
            : {})
        }),
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
