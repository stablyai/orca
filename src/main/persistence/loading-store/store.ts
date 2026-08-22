/* eslint-disable max-lines -- Why: persistence keeps schema defaults, migration, and load/save/flush in one file so the storage contract reviews as a unit. */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  unlinkSync,
  copyFileSync,
  statSync
} from 'node:fs'
import { rename, mkdir, rm, copyFile, open, stat, access, writeFile } from 'node:fs/promises'
import {
  durableWriteTempPath,
  removeStaleDurableWriteTempFiles,
  renameDurable,
  writeFileDurableSync
} from '../../durable-file-write'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import type {
  Automation,
  AutomationCreateInput,
  AutomationDispatchResult,
  AutomationRun,
  AutomationRunTrigger,
  AutomationUpdateInput
} from '../../../shared/automations-types'
import { normalizeProxyUrl } from '../../../shared/network-proxy'
import { normalizeKagiSessionLink } from '../../../shared/browser-url'
import type { FolderWorkspace, WorkspaceKey } from '../../../shared/folder-workspace-types'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { OnboardingChecklistState } from '../../../shared/onboarding-state-types'
import type {
  PersistedMobileClientTabSelections,
  PersistedState
} from '../../../shared/persisted-state-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type {
  Project,
  ProjectHostSetup,
  ProjectHostSetupCreateArgs,
  ProjectHostSetupCreateResult,
  ProjectHostSetupDeleteArgs,
  ProjectHostSetupDeleteResult,
  ProjectHostSetupUpdateArgs,
  ProjectHostSetupUpdateResult,
  ProjectUpdateArgs
} from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../shared/workspace-session-state-types'
import type { SparsePreset } from '../../../shared/worktree/create-types'
import type { WorkspaceLineage, WorktreeLineage } from '../../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { deriveGlobalWindowsRuntimeDefaultFromLegacySettings } from '../../../shared/project-execution-runtime'
import { normalizeStoredTaskSourceContext } from '../../../shared/task-source-context'
import { normalizeWorkspaceLinkedItem } from '../../../shared/workspace-linked-item'
import { isWorkspaceLinkedItemSourceContextMatch } from '../../../shared/workspace-linked-item-source-context'
import { normalizePersistedMobileClientTabSelections } from '../../runtime/client-session-tab-selection-persistence'
import { sanitizeWorkspaceSessionTerminalRetirements } from '../../runtime/mobile-session-terminal-persistence-retirement'
import {
  removeRepoFromHostWorkspaceSessions,
  removeRepoFromWorkspaceSession
} from '../../orca-profiles/profile-project-session-state'
import type {
  RemovedSshTargetTombstone,
  SshPtyConsumerRecovery,
  SshRemotePtyLease,
  SshTarget
} from '../../../shared/ssh-types'
import { isFolderRepo } from '../../../shared/repo-kind'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import {
  getDefaultPersistedState,
  getDefaultOnboardingState,
  getDefaultVoiceSettings,
  getDefaultWorkspaceSession,
  getWorktreeCardModeProperties,
  isDefaultedCompactWorktreeCardProperties,
  normalizeWorktreeCardProperties
} from '../../../shared/constants'
import { parseWorkspaceSessionSalvaging } from '../../../shared/workspace-session-salvage'
import { isExistingPersistedProfile } from '../../../shared/project-order-manual-default-notice'
import { resolveUsagePercentageDisplayChangeNoticeDismissed } from '../../../shared/usage-percentage-display-change-notice'
import { normalizePRBotAuthorOverrides } from '../../../shared/pr-bot-author-overrides'
import { toRelaySshPtyId } from '../../providers/ssh-pty-id'
import { isTerminalLeafId } from '../../../shared/stable-pane-id'
import {
  setMigrationUnsupportedPty,
  setMigrationUnsupportedPtyPersistenceListener
} from '../../agent-hooks/migration-unsupported-pty-state'
import { agentHookServer } from '../../agent-hooks/server'
import { pruneLocalTerminalScrollbackBuffers } from '../../../shared/workspace-session-terminal-buffers'
import {
  backfillAutomationRunNumbers,
  pruneAutomationRuns
} from '../../../shared/automation-run-retention'
import { pruneWorkspaceSessionBrowserHistory } from '../../../shared/workspace-session-browser-history'
import { normalizeRetirableGeneratedName } from '../../worktree-name-retirement'
import { recordRetirementNamespaceRegistry } from '../../worktree-retirement-namespace'
import {
  addRetiredNames,
  clampExhaustedTiers,
  compactRetiredNames,
  EMPTY_RETIRED_NAME_REGISTRY,
  isEmptyRetiredNameRegistry,
  type RetiredNameRegistry
} from '../../../shared/worktree/retired-name-registry'
import { getRepoIdFromWorktreeId, getWorktreePathBasenameFromId } from '../../../shared/worktree/id'
import { hasWorktreeRemovalRepoOwnerOnOtherHost } from '../../worktree-removal-repo-owner'
import { isPathInsideOrEqual } from '../../../shared/cross-platform-path'
import { normalizeTerminalQuickCommands } from '../../../shared/terminal-quick-commands'
import { normalizeTaskProviderSettings } from '../../../shared/task-providers'
import { normalizeAutoRenameBranchFromWorkDefaultOn } from '../../../shared/auto-rename-branch-from-work-settings'
import {
  addMobilePairingCustomAddress,
  normalizeMobilePairingCustomAddress,
  normalizeMobilePairingCustomAddresses
} from '../../../shared/mobile-pairing-custom-address'
import { normalizeOpenInApplications } from '../../../shared/open-in-applications'
import { normalizeTerminalShortcutPolicy } from '../../../shared/keybindings'
import { normalizeSourceControlGroupOrder } from '../../../shared/source-control-group-order'
import { normalizeAppIconId } from '../../../shared/app-icon'
import { normalizeTerminalCustomThemes } from '../../../shared/terminal-custom-themes'
import {
  normalizeFeatureInteractionTelemetryBuckets,
  type FeatureInteractionId
} from '../../../shared/feature-interactions'
import {
  parseCodexResetCreditAttemptLedger,
  type CodexResetCreditAttemptLedger
} from '../../../shared/codex-reset-credit-attempt-ledger'
import {
  DEFAULT_WORKSPACE_STATUS_ID,
  normalizePersistedWorkspaceStatuses
} from '../../../shared/workspace-statuses'
import { migrateExternalWorktreeVisibilityDefaults } from '../../../shared/external-worktree-visibility'
import {
  clearMissingProjectGroupMemberships,
  createProjectGroup,
  normalizeProjectGroups
} from '../../../shared/project-groups'
import { createNestedProjectGroupResolver } from '../../project-groups/nested-repo-import'
import {
  mergeLegacyCommitMessageAiIntoSourceControlAi,
  projectSourceControlAiToLegacyCommitMessageAi,
  sourceControlAiSettingsFromLegacy
} from '../../../shared/source-control-ai'
import { normalizeDisabledTuiAgents } from '../../../shared/tui-agent-selection'
import { hasUnsupportedTuiAgentArgs } from '../../../shared/tui-agent-launch-defaults'
import { normalizeTerminalCursorStyleDefault } from '../../../shared/terminal-cursor-style-settings'
import {
  normalizeOsc52ClipboardDefaultOn,
  osc52ClipboardDefaultOnOverridesPersistedOff
} from '../../../shared/osc52-clipboard-settings'
import { normalizeTerminalLineHeight } from '../../../shared/terminal-line-height-settings'
import { normalizeUiLanguage } from '../../../shared/ui-language'
import { ActiveViewPreference } from '../../active-view-preference'
import {
  collectFolderWorkspaceDiffComments,
  normalizeFolderWorkspaceDiffComments
} from '../../folder-workspace-diff-comments'
import { normalizeFolderWorkspaces } from '../../../shared/folder-workspaces'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import {
  collectTerminalScrollbackSnapshotRefs,
  deleteTerminalScrollbackSnapshotSync,
  getProfileTerminalScrollbackSnapshotRoot,
  migrateWorkspaceSessionTerminalScrollbackSnapshots,
  readTerminalScrollbackSnapshotSync,
  type TerminalScrollbackSnapshotStorage
} from '../../terminal-scrollback-snapshots'
import {
  deleteRemovedTerminalScrollbackSnapshotsAsync,
  migrateWorkspaceSessionTerminalScrollbackSnapshotsAsync
} from '../../terminal-scrollback-snapshot-async-migration'
import {
  isStartupDiagnosticsEnabled,
  logStartupDiagnostic
} from '../../startup/startup-diagnostics'
import {
  PROTECTED_SECRET_SLOT,
  ProtectedSecretPersistence,
  sshPtyOwnerLeaseSecretSlot,
  type ProtectedSecretRetentionUpdate
} from '../../protected-secret-persistence'
import {
  isLegacyOpenCodeSessionCookie,
  isLegacySshPtyOwnerLease
} from '../leasing-ssh-ptys/secret-validation'
import { getDataFile, getGithubCacheFile, readGithubCacheSnapshot } from './user-data-path'
import {
  STALE_DURABLE_WRITE_TEMP_AGE_MS,
  gcStaleWorktreeMeta,
  normalizeWorktreeLinkedItemMetadata
} from '../tracking-repos/worktree-metadata-normalization'
import {
  migrateAgentYoloDefaults,
  migrateTerminalScrollbackRows,
  migrateTerminalTuiScrollSensitivityDefault,
  stripRetiredGlobalSettings
} from '../applying-settings/terminal-settings-migrations'
import {
  normalizeRightSidebarExplorerView,
  normalizeRightSidebarTab,
  normalizeShowDotfilesByWorktree,
  normalizeSortBy
} from '../applying-settings/ui-selection-normalization'
import {
  normalizeWorkspaceLineageByChildKey,
  stripMainOwnedTelemetryMarkerFromUI
} from '../applying-settings/ui-interaction-merge'
import {
  backfillLegacyAutomationContexts,
  normalizeAutomationRunWorkspaceDisplayName
} from '../scheduling-automations/automation-context-migration'
import {
  normalizeLoadedOnboardingState,
  normalizeNotificationSettings,
  persistedNotificationSettingsRepaired,
  readDeprecatedExperimentFlag,
  readLegacySidekickFlag,
  resolveSetupGuideSidebarDismissedOnLoad
} from '../applying-settings/onboarding-normalization'
import {
  canonicalizePersistedFloatingWorkspaceDirectory,
  normalizeFloatingWorkspaceTrustedCwds
} from '../restoring-sessions/floating-workspace-normalization'
import {
  ENCRYPTED_SSH_PTY_OWNER_LEASE_MAX_LENGTH,
  normalizeSshPtyConsumerRecovery,
  normalizeSshRemotePtyLease,
  normalizeSshTarget
} from '../leasing-ssh-ptys/ssh-normalization'
import {
  type SshTargetStateOperations,
  addClaudeLivePtySessionId as addClaudeLivePtySessionIdOperation,
  addDeletedSshConfigAlias as addDeletedSshConfigAliasOperation,
  addRemovedSshTargetTombstone as addRemovedSshTargetTombstoneOperation,
  addSshTarget as addSshTargetOperation,
  clearDeletedSshConfigAliases as clearDeletedSshConfigAliasesOperation,
  getClaudeLivePtySessionIds as getClaudeLivePtySessionIdsOperation,
  getDeletedSshConfigAliases as getDeletedSshConfigAliasesOperation,
  getRemovedSshTargetTombstones as getRemovedSshTargetTombstonesOperation,
  getSshTarget as getSshTargetOperation,
  getSshTargets as getSshTargetsOperation,
  removeClaudeLivePtySessionId as removeClaudeLivePtySessionIdOperation,
  removeDeletedSshConfigAlias as removeDeletedSshConfigAliasOperation,
  removeRemovedSshTargetTombstone as removeRemovedSshTargetTombstoneOperation,
  removeSshTarget as removeSshTargetOperation,
  updateSshTarget as updateSshTargetOperation
} from '../leasing-ssh-ptys/ssh-target-state'
import {
  reassignSshTargetId as reassignSshTargetIdOperation,
  type SshTargetReassignmentOperations
} from '../leasing-ssh-ptys/ssh-target-reassignment'
import {
  getSshRemotePtyLeases as getSshRemotePtyLeasesOperation,
  markSshRemotePtyLease as markSshRemotePtyLeaseOperation,
  markSshRemotePtyLeases as markSshRemotePtyLeasesOperation,
  markSshRemotePtyLeasesAsync as markSshRemotePtyLeasesAsyncOperation,
  markSshRemotePtyLeasesAttachedAsync as markSshRemotePtyLeasesAttachedAsyncOperation,
  markSshRemotePtyLeasesForShutdown as markSshRemotePtyLeasesForShutdownOperation,
  removeSshRemotePtyLease as removeSshRemotePtyLeaseOperation,
  removeSshRemotePtyLeases as removeSshRemotePtyLeasesOperation,
  type SshPtyLeaseOperations,
  upsertSshRemotePtyLease as upsertSshRemotePtyLeaseOperation
} from '../leasing-ssh-ptys/ssh-pty-lease-operations'
import {
  getSshPtyConsumerRecovery as getSshPtyConsumerRecoveryOperation,
  removeSshPtyConsumerRecovery as removeSshPtyConsumerRecoveryOperation,
  type SshPtyConsumerRecoveryOperations,
  upsertSshPtyConsumerRecovery as upsertSshPtyConsumerRecoveryOperation
} from '../leasing-ssh-ptys/ssh-pty-consumer-recovery'
import {
  clearSshRemotePtyBindingsForLeases as clearSshRemotePtyBindingsForLeasesOperation,
  clearSshRemotePtyBindingsForTarget as clearSshRemotePtyBindingsForTargetOperation,
  type SshPtyBindingCleanupOperations
} from '../leasing-ssh-ptys/ssh-pty-binding-cleanup'
import {
  cloneLayoutNode,
  layoutContainsLeafId,
  preserveMissingLeafRecordEntries
} from '../restoring-sessions/terminal-layout-normalization'
import { findWorktreeIdForTab } from '../restoring-sessions/pane-identity-migration'
import {
  normalizeClaudeLivePtySessionIds,
  normalizeLegacyPaneKeyAliasEntries,
  normalizeMigrationUnsupportedPtyEntries,
  registerPersistedPaneKeyAlias
} from '../restoring-sessions/pane-alias-normalization'
import {
  normalizePersistedPaneIdentityState,
  normalizeWorkspaceSessionPaneIdentities,
  remapAcknowledgedAgentPaneKeys,
  remapSshRemotePtyLeaseLeafIds,
  type WorkspaceSessionPaneIdentityRemap
} from '../restoring-sessions/workspace-pane-normalization'
import {
  mergeProjectHostSetupCompatibilityState,
  projectHostSetupCompatibilityStateEqual
} from '../tracking-repos/project-host-compatibility'
import {
  cloneWorkspaceSessionState,
  createMinimalPersistedTerminalTab
} from '../restoring-sessions/session-owner-fields'
import {
  removeWorkspaceSessionOwner,
  workspaceSessionOwnerPartitionForHost,
  workspaceSessionPartitionIdsForHost
} from '../restoring-sessions/session-owner-removal'
import { backfillFolderScopeConnectionIds } from '../restoring-sessions/folder-scope-migration'
import {
  createAutomation as createAutomationOperation,
  deleteAutomation as deleteAutomationOperation,
  listAutomations as listAutomationsOperation,
  updateAutomation as updateAutomationOperation,
  type AutomationDefinitionOperations
} from '../scheduling-automations/automation-definition-operations'
import {
  createAutomationRun as createAutomationRunOperation,
  listAutomationRuns as listAutomationRunsOperation,
  snapshotAutomationRunWorkspaceDisplayName as snapshotAutomationRunWorkspaceDisplayNameOperation,
  updateAutomationRun as updateAutomationRunOperation,
  type AutomationRunOperations
} from '../scheduling-automations/automation-run-operations'
import {
  advanceAutomationNextRun as advanceAutomationNextRunOperation,
  getLatestAutomationOccurrence as getLatestAutomationOccurrenceOperation
} from '../scheduling-automations/automation-schedule-operations'
import { migrateWorktreeIdentity as migrateWorktreeIdentityOperation } from '../tracking-repos/worktree-identity-migration'
import {
  updateSettings as updateSettingsOperation,
  type SettingsMutationOperations
} from '../applying-settings/settings-update'
import { getPersistedUI } from '../applying-settings/ui-state-read'
import { updatePersistedUI, type UIUpdateOperations } from '../applying-settings/ui-state-update'
import { ProjectGroupPersistenceOperations } from '../tracking-repos/project-group-operations'
import { FolderWorkspacePersistenceOperations } from '../restoring-sessions/folder-workspace-operations'
import { RepoOrderPersistenceOperations } from '../tracking-repos/repo-order-operations'
import { pruneWorktreeStateForRepo as pruneWorktreeStateForRepoOperation } from '../tracking-repos/repo-worktree-pruning'
import { ProjectHostPersistenceOperations } from '../tracking-repos/project-host-operations'
import {
  recordFeatureInteraction as recordFeatureInteractionOperation,
  type FeatureInteractionOperations
} from '../applying-settings/feature-interaction-recording'
import { hydrateRepo as hydrateRepoOperation } from '../tracking-repos/repo-hydration'
import { RepoUpdatePersistenceOperations } from '../tracking-repos/repo-update-operations'
import { ProjectHostSetupPersistenceOperations } from '../tracking-repos/project-host-setup-update'

// Why (issue #1158): keep 5 rolling backups at >=1h spacing so a corrupt/empty write leaves an earlier copy recoverable.
const BACKUP_COUNT = 5
const BACKUP_MIN_INTERVAL_MS = 60 * 60 * 1000
const WORKSPACE_SESSION_PATCH_FULL_NORMALIZATION_KEYS = new Set<keyof WorkspaceSessionState>([
  'tabsByWorktree',
  'terminalLayoutsByTabId'
])

function logPersistenceStartupMilestone(
  event: string,
  details: Record<string, unknown> = {}
): void {
  if (isStartupDiagnosticsEnabled()) {
    logStartupDiagnostic(event, { t: Math.round(performance.now()), ...details })
  }
}

function workspaceSessionPatchNeedsFullNormalization(patch: WorkspaceSessionPatch): boolean {
  return Object.keys(patch).some((key) =>
    WORKSPACE_SESSION_PATCH_FULL_NORMALIZATION_KEYS.has(key as keyof WorkspaceSessionState)
  )
}

function workspaceSessionSalvageLogDetails(result: {
  droppedCount: number
  droppedPaths: string[]
}): { count: number; fields: string[]; detailsTruncated: boolean } {
  return {
    count: result.droppedCount,
    fields: [...new Set(result.droppedPaths.map((path) => path.split('.', 1)[0]))],
    detailsTruncated: result.droppedCount > result.droppedPaths.length
  }
}

/** Normalize non-'local' host partitions; 'local' (the legacy workspaceSession blob) is dropped so the two surfaces never diverge.
 *  Each partition is zod-validated independently, so one corrupt host drops to defaults without taking out the others. Idempotent. */
function parseWorkspaceSessionsByHostId(
  raw: unknown,
  defaults: WorkspaceSessionState
): { partitions: Partial<Record<ExecutionHostId, WorkspaceSessionState>>; repaired: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { partitions: {}, repaired: raw !== undefined }
  }
  let repaired = false
  const partitions: Partial<Record<ExecutionHostId, WorkspaceSessionState>> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const hostId = normalizeExecutionHostId(key)
    // Why: 'local' lives in workspaceSession; a local/invalid key here is legacy noise that must not shadow the canonical partition.
    if (!hostId || hostId === LOCAL_EXECUTION_HOST_ID) {
      continue
    }
    const result = parseWorkspaceSessionSalvaging(value)
    if (!result.ok) {
      repaired = true
      console.error(
        `[persistence] Corrupt workspace session for host ${hostId}, using defaults:`,
        result.error
      )
      continue
    }
    if (result.droppedCount > 0) {
      console.warn(
        `[persistence] Salvaged workspace session for host ${hostId}; dropped corrupt entries:`,
        workspaceSessionSalvageLogDetails(result)
      )
      repaired = true
    }
    partitions[hostId] = { ...defaults, ...result.value }
  }
  return { partitions, repaired }
}

function backupPath(dataFile: string, index: number): string {
  return `${dataFile}.bak.${index}`
}

/** existsSync's non-blocking twin: existsSync is an access(F_OK) probe, so access() is the exact analogue. */
async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  )
}

function normalizeRetiredNameRegistry(row: unknown): RetiredNameRegistry {
  const isPlainArray = Array.isArray(row)
  const rawRow = row as { exhaustedTiers?: unknown; names?: unknown } | null | undefined
  const rawNames = isPlainArray ? row : Array.isArray(rawRow?.names) ? rawRow.names : []
  const names = new Set<string>()
  for (const entry of rawNames) {
    if (typeof entry !== 'string') {
      continue
    }
    const normalized = normalizeRetirableGeneratedName(entry)
    if (normalized) {
      names.add(normalized)
    }
  }
  return compactRetiredNames({
    exhaustedTiers: isPlainArray ? 0 : clampExhaustedTiers(rawRow?.exhaustedTiers),
    names: [...names]
  })
}

function normalizeRetiredNameRegistryMap(value: unknown): Record<string, RetiredNameRegistry> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const byRepo: Record<string, RetiredNameRegistry> = {}
  for (const [repoId, row] of Object.entries(value as Record<string, unknown>)) {
    if (!repoId) {
      continue
    }
    const registry = normalizeRetiredNameRegistry(row)
    if (!isEmptyRetiredNameRegistry(registry)) {
      byRepo[repoId] = registry
    }
  }
  return byRepo
}

function deleteRemovedTerminalScrollbackSnapshots(
  prior: WorkspaceSessionState | undefined,
  next: WorkspaceSessionState,
  storage?: TerminalScrollbackSnapshotStorage
): void {
  if (!prior) {
    return
  }
  const nextRefs = collectTerminalScrollbackSnapshotRefs(next)
  for (const ref of collectTerminalScrollbackSnapshotRefs(prior)) {
    if (!nextRefs.has(ref)) {
      deleteTerminalScrollbackSnapshotSync(ref, storage)
    }
  }
}

export type StoreOptions = {
  dataFile?: string
}

export type PtyBindingSourceExpectation = {
  worktreeId?: string
  tabId: string
  leafId: string
  ptyId: string
  incarnationId?: string
}

export class Store {
  // Why readonly: the operations wrappers below capture this reference once and are memoized.
  private readonly state: PersistedState
  private readonly dataFile: string
  private readonly activeViewPreference: ActiveViewPreference
  private readonly terminalScrollbackSnapshotStorage: TerminalScrollbackSnapshotStorage
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  private pendingWrite: Promise<void> | null = null
  private pendingSnapshotFileWork: Promise<void> | null = null
  private readonly staleTempCleanup: Promise<void>
  private writeGeneration = 0
  private inFlightAsyncTmpFile: string | null = null
  // Prevent a sync flush from interleaving a second rotation with awaited ring mutations.
  private backupRotationInFlight = false
  // Why: after a profile transfer rewrites this file on disk, a late flush of stale in-memory state would resurrect the moved project.
  private writesFrozen = false
  /** Set by flushAsync so the quit flush is the final write; see scheduleSave. */
  private quitFlushStarted = false
  private quitFlushPromise: Promise<void> | null = null
  // Content hash at last write, to skip no-op writes; derived from the payload with encrypted blobs normalized back to plaintext (see buildStateToSave), since encrypt() uses a random IV per call.
  private lastWrittenStateHash: string | null = null
  private lastDurableWriteGeneration = -1
  private firstPendingSaveAt: number | null = null
  private githubCacheDirty = false
  private githubCacheGeneration = 0
  private pendingGithubCacheWrite: Promise<void> | null = null
  private readonly staleGithubCacheTempCleanup: Promise<void>
  private readonly gitUsernameCache = new Map<string, string>()
  private readonly protectedSecrets = new ProtectedSecretPersistence()
  private loadNeedsSave = false
  private settingsChangeListeners = new Set<
    (
      updates: Partial<GlobalSettings>,
      settings: GlobalSettings,
      originWebContentsId?: number
    ) => void
  >()
  private uiChangeListeners = new Set<(ui: PersistedState['ui']) => void>()

  constructor(options: StoreOptions = {}) {
    // Why: profile switching yields multiple state paths; capture per Store so late async writes can't follow a global path.
    this.dataFile = options.dataFile ?? getDataFile()
    this.staleTempCleanup = removeStaleDurableWriteTempFiles(this.dataFile, {
      minimumAgeMs: STALE_DURABLE_WRITE_TEMP_AGE_MS
    })
    this.staleGithubCacheTempCleanup = removeStaleDurableWriteTempFiles(
      getGithubCacheFile(this.dataFile),
      { minimumAgeMs: STALE_DURABLE_WRITE_TEMP_AGE_MS }
    )
    const profileSnapshotRoot = getProfileTerminalScrollbackSnapshotRoot(this.dataFile)
    const legacySnapshotRoot = getProfileTerminalScrollbackSnapshotRoot(getDataFile())
    this.terminalScrollbackSnapshotStorage = {
      snapshotRoot: profileSnapshotRoot,
      fallbackSnapshotRoot: legacySnapshotRoot === profileSnapshotRoot ? null : legacySnapshotRoot
    }
    const loaded = this.load()
    const normalized = normalizePersistedPaneIdentityState(loaded)
    this.state = normalized.state
    // Why: activeView is a frequent, tiny preference; keeping it beside the
    // profile avoids serializing the multi-MB recovery store on navigation.
    this.activeViewPreference = new ActiveViewPreference(this.dataFile, this.state.ui?.activeView)
    const adaptedProjectGroups = this.adaptFlatFolderScanProjectGroups()
    this.hydrateFolderWorkspaceDiffComments()
    for (const entry of normalized.migrationUnsupportedEntries) {
      setMigrationUnsupportedPty(entry)
    }
    for (const entry of normalized.legacyPaneKeyAliasEntries) {
      registerPersistedPaneKeyAlias(entry)
    }
    setMigrationUnsupportedPtyPersistenceListener((entries) => {
      this.state.migrationUnsupportedPtyEntries = entries
      this.scheduleSave()
    })
    agentHookServer.setPaneKeyAliasPersistenceListener((entries) => {
      this.state.legacyPaneKeyAliasEntries = entries
      this.scheduleSave()
    })
    if (normalized.changed || this.loadNeedsSave || adaptedProjectGroups) {
      // Why: rewrite legacy pane:1 leaves so older renderer writes can't revive them; other migrations also set loadNeedsSave.
      this.scheduleSave()
    }
  }

  // Why: notes live top-level on disk so an older build's field-by-field
  // normalizeFolderWorkspaces can't drop them; re-attach them to the in-memory records here.
  private hydrateFolderWorkspaceDiffComments(): void {
    const stored = this.state.folderWorkspaceDiffComments
    let relocatedInline = false
    for (const workspace of this.state.folderWorkspaces ?? []) {
      if (Array.isArray(workspace.diffComments) && workspace.diffComments.length > 0) {
        // Inline wins: an intervening rollback to a #14112 build writes notes inline and leaves the
        // older map untouched, so inline is the last notes-aware write. Also makes the relocation
        // durable even if the user never edits anything this session.
        relocatedInline = true
        continue
      }
      const comments = stored?.[workspace.id]
      // Not `??`: a degenerate `{ id: [] }` entry must not delete an intact inline value.
      if (Array.isArray(comments) && comments.length > 0) {
        workspace.diffComments = comments
      }
    }
    if (relocatedInline) {
      this.loadNeedsSave = true
    }
    // Write-only projection: buildStateToSave() is the only producer, so leaving the loaded map in
    // state would make it a stale second source of truth that getDurableState() spreads back out.
    delete this.state.folderWorkspaceDiffComments
  }

  private adaptFlatFolderScanProjectGroups(): boolean {
    // Why: older folder imports kept a real parent path but flat repos; upgrade that shape into v1 sparse folder scopes.
    const groups = this.state.projectGroups ?? []
    const repos = this.state.repos
    if (groups.length === 0 || repos.length === 0) {
      return false
    }

    let changed = false
    let maxOrder = -1
    for (const group of groups) {
      maxOrder = Math.max(maxOrder, group.tabOrder)
    }

    const childGroupIds = new Set(
      groups.flatMap((group) => (group.parentGroupId ? [group.parentGroupId] : []))
    )
    const initialGroupCount = groups.length
    for (let groupIndex = 0; groupIndex < initialGroupCount; groupIndex += 1) {
      const rootGroup = groups[groupIndex]
      if (!rootGroup) {
        continue
      }
      if (
        rootGroup.createdFrom !== 'folder-scan' ||
        !rootGroup.parentPath ||
        rootGroup.parentGroupId ||
        childGroupIds.has(rootGroup.id)
      ) {
        continue
      }
      const rootPath = rootGroup.parentPath
      const repoCandidates = repos.filter(
        (repo) =>
          !isFolderRepo(repo) &&
          repo.projectGroupId === rootGroup.id &&
          isPathInsideOrEqual(rootPath, repo.path)
      )
      if (repoCandidates.length < 2) {
        continue
      }

      const resolver = createNestedProjectGroupResolver({
        parentPath: rootPath,
        groupName: rootGroup.name,
        mode: 'group',
        repoPaths: repoCandidates.map((repo) => repo.path),
        createGroup: (input) => {
          if (!input.parentGroupId) {
            return rootGroup
          }
          maxOrder += 1
          const group = createProjectGroup({
            ...input,
            tabOrder: maxOrder
          })
          groups.push(group)
          changed = true
          return group
        }
      })
      const nextOrderByGroupId = new Map<string, number>()
      for (const repo of repoCandidates) {
        const group = resolver.getGroupForRepo(repo.path)
        if (!group) {
          continue
        }
        const nextOrder = nextOrderByGroupId.get(group.id) ?? 0
        nextOrderByGroupId.set(group.id, nextOrder + 1)
        if (repo.projectGroupId !== group.id || repo.projectGroupOrder !== nextOrder) {
          repo.projectGroupId = group.id
          repo.projectGroupOrder = nextOrder
          changed = true
        }
      }
    }
    return changed
  }

  // Why (#1158): debounced writes fire ~every 300ms; throttle backups to distinct moments, not near-identical snapshots.
  private shouldRotateBackups(now: number, dataFile: string): boolean {
    try {
      const mtime = statSync(backupPath(dataFile, 0)).mtimeMs
      return now - mtime >= BACKUP_MIN_INTERVAL_MS
    } catch {
      return true
    }
  }

  // Why separate from the sync twin: a statSync here parks the Electron main thread in uninterruptible
  // sleep on a stalled SMB/NFS profile mount. Error semantics are deliberately identical: rotate.
  private async shouldRotateBackupsAsync(dataFile: string): Promise<boolean> {
    try {
      const mtime = (await stat(backupPath(dataFile, 0))).mtimeMs
      return Date.now() - mtime >= BACKUP_MIN_INTERVAL_MS
    } catch {
      return true
    }
  }

  // Why: rotate current file into the .bak ring so load() can recover if a later primary write is truncated or corrupt.
  private async rotateBackupsAsync(dataFile: string): Promise<void> {
    if (this.backupRotationInFlight) {
      return
    }
    this.backupRotationInFlight = true
    try {
      if (!(await this.shouldRotateBackupsAsync(dataFile))) {
        return
      }
      if (!(await exists(dataFile))) {
        return
      }
      await rm(backupPath(dataFile, BACKUP_COUNT - 1)).catch((err: unknown) => {
        if (err && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error('[persistence] Failed to remove oldest backup:', err)
        }
      })
      for (let i = BACKUP_COUNT - 2; i >= 0; i--) {
        const src = backupPath(dataFile, i)
        const dst = backupPath(dataFile, i + 1)
        // Why probe instead of rename-then-swallow-ENOENT: a degraded mount rejects a rename of an
        // absent slot with ESTALE/EIO, which would log once per empty slot on every debounced save.
        if (await exists(src)) {
          await rename(src, dst).catch((err) => {
            console.error('[persistence] Failed to rotate backup', src, '->', dst, err)
          })
        }
      }
      await copyFile(dataFile, backupPath(dataFile, 0)).catch((err) => {
        console.error('[persistence] Failed to snapshot current file to .bak.0:', err)
      })
    } finally {
      this.backupRotationInFlight = false
    }
  }

  private rotateBackupsSync(dataFile: string): void {
    if (!existsSync(dataFile)) {
      return
    }
    try {
      unlinkSync(backupPath(dataFile, BACKUP_COUNT - 1))
    } catch (err) {
      if (err && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[persistence] Failed to remove oldest backup:', err)
      }
    }
    for (let i = BACKUP_COUNT - 2; i >= 0; i--) {
      const src = backupPath(dataFile, i)
      const dst = backupPath(dataFile, i + 1)
      if (existsSync(src)) {
        try {
          renameSync(src, dst)
        } catch (err) {
          console.error('[persistence] Failed to rotate backup', src, '->', dst, err)
        }
      }
    }
    try {
      copyFileSync(dataFile, backupPath(dataFile, 0))
    } catch (err) {
      console.error('[persistence] Failed to snapshot current file to .bak.0:', err)
    }
  }

  private restoreFromBackup(dataFile: string): boolean {
    for (let i = 0; i < BACKUP_COUNT; i++) {
      const path = backupPath(dataFile, i)
      if (!existsSync(path)) {
        continue
      }
      try {
        const raw = readFileSync(path, 'utf-8')
        JSON.parse(raw)
        mkdirSync(dirname(dataFile), { recursive: true })
        writeFileSync(dataFile, raw, 'utf-8')
        console.warn(`[persistence] Recovered state from backup slot ${i}: ${path}`)
        return true
      } catch (err) {
        console.error(`[persistence] Backup slot ${i} unusable, trying next:`, err)
      }
    }
    return false
  }

  private load(allowBackupRecovery = true): PersistedState {
    // Capture "has run Orca before?" for telemetry cohort; the telemetry field is new, so field inference misclassifies old users as fresh.
    const dataFile = this.dataFile
    const fileExistedOnLoad = existsSync(dataFile)
    logPersistenceStartupMilestone('persistence-load-start', {
      fileExists: fileExistedOnLoad
    })

    let result: PersistedState | null = null
    try {
      if (fileExistedOnLoad) {
        const readStartedAt = performance.now()
        const raw = readFileSync(dataFile, 'utf-8')
        logPersistenceStartupMilestone('persistence-read-done', {
          bytes: Buffer.byteLength(raw),
          durationMs: Math.round(performance.now() - readStartedAt)
        })
        logPersistenceStartupMilestone('persistence-json-parse-start')
        const parsed = JSON.parse(raw) as PersistedState
        logPersistenceStartupMilestone('persistence-json-parse-done')

        // Why: secrets are stored encrypted via safeStorage; decrypt at the load boundary so the app sees plaintext.
        if (parsed.settings?.opencodeSessionCookie) {
          parsed.settings.opencodeSessionCookie = this.protectedSecrets.decrypt(
            PROTECTED_SECRET_SLOT.opencodeSessionCookie,
            parsed.settings.opencodeSessionCookie,
            isLegacyOpenCodeSessionCookie
          )
        }
        if (parsed.settings?.httpProxyUrl) {
          const decryptedProxy = this.protectedSecrets.decryptWithStatus(
            PROTECTED_SECRET_SLOT.httpProxyUrl,
            parsed.settings.httpProxyUrl,
            (value) => normalizeProxyUrl(value).ok
          )
          // Why (STA-3442): after a keychain reset decrypt returns raw ciphertext; a non-URL
          // value must not masquerade as a configured proxy (silent DIRECT fallback) or
          // re-persist as garbage. Plaintext URLs still pass, preserving the upgrade path.
          if (
            decryptedProxy.status === 'unavailable' ||
            (decryptedProxy.status === 'failed' && !decryptedProxy.plaintext)
          ) {
            parsed.settings.httpProxyUrl = ''
          } else if (normalizeProxyUrl(decryptedProxy.plaintext).ok) {
            parsed.settings.httpProxyUrl = decryptedProxy.plaintext
          } else {
            console.warn(
              '[persistence] httpProxyUrl could not be decrypted — clearing the stored proxy URL. Re-enter it in Settings > Advanced > Network.'
            )
            parsed.settings.httpProxyUrl = ''
            this.protectedSecrets.removeRetainedBlob(PROTECTED_SECRET_SLOT.httpProxyUrl)
            this.loadNeedsSave = true
          }
        }
        if (parsed.ui?.browserKagiSessionLink) {
          parsed.ui.browserKagiSessionLink = this.protectedSecrets.decrypt(
            PROTECTED_SECRET_SLOT.browserKagiSessionLink,
            parsed.ui.browserKagiSessionLink,
            (value) => normalizeKagiSessionLink(value) !== null
          )
        }
        parsed.sshPtyConsumerRecoveries = (
          Array.isArray(parsed.sshPtyConsumerRecoveries) ? parsed.sshPtyConsumerRecoveries : []
        )
          .map((record) =>
            normalizeSshPtyConsumerRecovery(record, ENCRYPTED_SSH_PTY_OWNER_LEASE_MAX_LENGTH)
          )
          .filter((record): record is SshPtyConsumerRecovery => record !== null)
          .map((record) => {
            const slot = sshPtyOwnerLeaseSecretSlot(record.targetId)
            const decrypted = this.protectedSecrets.decryptWithStatus(
              slot,
              record.ownerLease,
              isLegacySshPtyOwnerLease
            )
            const normalized =
              decrypted.status === 'unavailable' ||
              (decrypted.status === 'failed' && !decrypted.plaintext)
                ? record
                : normalizeSshPtyConsumerRecovery({ ...record, ownerLease: decrypted.plaintext })
            if (!normalized) {
              this.protectedSecrets.removeRetainedBlob(slot)
            }
            return normalized
          })
          .filter((record): record is SshPtyConsumerRecovery => record !== null)

        // Merge with defaults in case new fields were added
        const homeDir = homedir()
        const defaults = getDefaultPersistedState(homeDir)
        const migratedExternalVisibility = migrateExternalWorktreeVisibilityDefaults(
          Array.isArray(parsed.repos) ? parsed.repos : [],
          parsed.settings?.worktreeVisibilityDefaults
        )
        if (migratedExternalVisibility.changed) {
          this.loadNeedsSave = true
        }
        const migratedTerminalScrollback = migrateTerminalScrollbackRows(parsed.settings)
        if (migratedTerminalScrollback.needsSave) {
          this.loadNeedsSave = true
        }
        if (
          parsed.settings &&
          typeof parsed.settings === 'object' &&
          Object.hasOwn(parsed.settings, 'enableGitHubAttribution')
        ) {
          this.loadNeedsSave = true
        }
        const migratedTerminalTuiScrollSensitivity = migrateTerminalTuiScrollSensitivityDefault(
          parsed.settings
        )
        if (migratedTerminalTuiScrollSensitivity.needsSave) {
          this.loadNeedsSave = true
        }
        const rawSourceControlAi = parsed.settings?.sourceControlAi
        const rawSourceControlAiMissing = rawSourceControlAi === undefined
        const rawSourceControlAiActionsMissing =
          rawSourceControlAi !== undefined && rawSourceControlAi.actions === undefined
        if (rawSourceControlAiMissing || rawSourceControlAiActionsMissing) {
          this.loadNeedsSave = true
        }
        const legacyCommitMessageAi = parsed.settings?.commitMessageAi
        const migratedSourceControlAi = rawSourceControlAiMissing
          ? sourceControlAiSettingsFromLegacy(
              legacyCommitMessageAi ?? defaults.settings.commitMessageAi
            )
          : mergeLegacyCommitMessageAiIntoSourceControlAi(
              parsed.settings?.sourceControlAi,
              legacyCommitMessageAi
            )
        // Why (issue #903): old 'true' default broke non-US Option-layer chars; flip 'true'→'auto' once so the layout probe decides.
        const rawOptionAsAlt = parsed.settings?.terminalMacOptionAsAlt
        const alreadyMigrated = parsed.settings?.terminalMacOptionAsAltMigrated === true
        const migratedOptionAsAlt: 'auto' | 'true' | 'false' | 'left' | 'right' = alreadyMigrated
          ? (rawOptionAsAlt ?? 'auto')
          : rawOptionAsAlt === undefined || rawOptionAsAlt === 'true'
            ? 'auto'
            : rawOptionAsAlt
        const floatingTerminalDefaultedForAllUsers =
          parsed.settings?.floatingTerminalDefaultedForAllUsers === true
        // Why: early builds persisted the old off default; flip only unmigrated profiles so a later opt-out survives reload.
        const migratedFloatingTerminalEnabled = floatingTerminalDefaultedForAllUsers
          ? (parsed.settings?.floatingTerminalEnabled ?? true)
          : true
        // Why: the old off default persisted `false` for every profile, indistinguishable from a real opt-out — flip unmigrated profiles once (#10567).
        const migratedOsc52Clipboard = normalizeOsc52ClipboardDefaultOn(parsed.settings)
        const osc52ClipboardNoticePending =
          osc52ClipboardDefaultOnOverridesPersistedOff(parsed.settings) ||
          parsed.ui?.osc52ClipboardDefaultOnNoticePending === true
        if (parsed.settings?.terminalAllowOsc52ClipboardDefaultedOnForAllUsers !== true) {
          this.loadNeedsSave = true
        }
        const floatingTerminalCwdMigrated =
          parsed.settings?.floatingTerminalCwdMigratedToAppWorkspace === true
        // Why: an earlier migration wrote '' for the notes dir; floating terminals still open at home, notes use a separate IPC.
        const migratedFloatingTerminalCwd = floatingTerminalCwdMigrated
          ? !parsed.settings?.floatingTerminalCwd
            ? defaults.settings.floatingTerminalCwd
            : parsed.settings.floatingTerminalCwd
          : parsed.settings?.floatingTerminalCwd === undefined
            ? defaults.settings.floatingTerminalCwd
            : parsed.settings.floatingTerminalCwd
        const normalizedFloatingTerminalTrustedCwds = normalizeFloatingWorkspaceTrustedCwds(
          parsed.settings?.floatingTerminalTrustedCwds,
          homeDir
        )
        const migratedFloatingTerminalTrustedCwds = [
          ...normalizedFloatingTerminalTrustedCwds.trustedCwds
        ]
        const rawLegacyFloatingTerminalCwd = parsed.settings?.floatingTerminalCwd
        const shouldTrustLegacyFloatingTerminalCwd =
          !floatingTerminalCwdMigrated &&
          typeof rawLegacyFloatingTerminalCwd === 'string' &&
          rawLegacyFloatingTerminalCwd.trim().length > 0 &&
          rawLegacyFloatingTerminalCwd.trim() !== '~'
        if (!floatingTerminalCwdMigrated) {
          this.loadNeedsSave = true
        }
        if (shouldTrustLegacyFloatingTerminalCwd && rawLegacyFloatingTerminalCwd) {
          const canonicalLegacyCwd = canonicalizePersistedFloatingWorkspaceDirectory(
            rawLegacyFloatingTerminalCwd,
            homeDir
          )
          if (
            canonicalLegacyCwd &&
            !migratedFloatingTerminalTrustedCwds.includes(canonicalLegacyCwd)
          ) {
            // Why: pre-grant profiles with an explicit Floating Workspace cwd already showed intent; migrate only that legacy value.
            migratedFloatingTerminalTrustedCwds.push(canonicalLegacyCwd)
            normalizedFloatingTerminalTrustedCwds.changed = true
          }
        }
        if (normalizedFloatingTerminalTrustedCwds.changed) {
          this.loadNeedsSave = true
        }
        const experimentalActivityDefaultedOffForAllUsers =
          parsed.settings?.experimentalActivityDefaultedOffForAllUsers === true
        // Why: the Agents view moved back behind Experimental; flip pre-migration profiles off once, then preserve opt-ins.
        const migratedExperimentalActivity = experimentalActivityDefaultedOffForAllUsers
          ? (parsed.settings?.experimentalActivity ?? false)
          : false
        const autoRenameBranchFromWorkDefaultedOn =
          parsed.settings?.autoRenameBranchFromWorkDefaultedOn === true
        // Why: default-on rollout activates old profiles once, but a later Settings opt-out survives reloads.
        const migratedAutoRenameBranchFromWork = normalizeAutoRenameBranchFromWorkDefaultOn(
          parsed.settings
        )
        const migratedTerminalCursorStyle = normalizeTerminalCursorStyleDefault(parsed.settings)
        if (
          parsed.settings?.terminalCursorStyle !==
            migratedTerminalCursorStyle.terminalCursorStyle ||
          parsed.settings?.terminalCursorStyleDefaultedToBlock !== true
        ) {
          this.loadNeedsSave = true
        }
        const migratedTerminalLineHeight = normalizeTerminalLineHeight(
          parsed.settings?.terminalLineHeight
        )
        const terminalRightClickToPasteDefaultedForPlatform =
          parsed.settings?.terminalRightClickToPasteDefaultedForPlatform === true
        if (!terminalRightClickToPasteDefaultedForPlatform) {
          this.loadNeedsSave = true
        }
        if (
          parsed.settings?.terminalLineHeight !== undefined &&
          parsed.settings.terminalLineHeight !== migratedTerminalLineHeight
        ) {
          this.loadNeedsSave = true
        }
        const rawTaskProviderSettings = normalizeTaskProviderSettings({
          visibleTaskProviders: parsed.settings?.visibleTaskProviders,
          defaultTaskSource: parsed.settings?.defaultTaskSource
        })
        const visibleTaskProvidersDefaultedForJira =
          parsed.settings?.visibleTaskProvidersDefaultedForJira === true
        const migratedVisibleTaskProviders = visibleTaskProvidersDefaultedForJira
          ? rawTaskProviderSettings.visibleTaskProviders
          : rawTaskProviderSettings.visibleTaskProviders.includes('jira')
            ? rawTaskProviderSettings.visibleTaskProviders
            : [...rawTaskProviderSettings.visibleTaskProviders, 'jira' as const]
        const taskProviderSettings = normalizeTaskProviderSettings({
          visibleTaskProviders: migratedVisibleTaskProviders,
          defaultTaskSource: rawTaskProviderSettings.defaultTaskSource
        })
        const primarySelectionDefaultedForLinux =
          parsed.settings?.primarySelectionMiddleClickPasteDefaultedForLinux === true
        const primarySelectionDefaultedForTerminalDefaults =
          parsed.settings?.primarySelectionMiddleClickPasteDefaultedForTerminalDefaults === true
        const primarySelectionPlatformDefaultEnabled =
          defaults.settings.primarySelectionMiddleClickPaste === true
        const primarySelectionAlreadyDefaultedForPlatform =
          primarySelectionDefaultedForTerminalDefaults ||
          (process.platform === 'linux' && primarySelectionDefaultedForLinux)
        const migratePrimarySelectionPlatformDefault =
          primarySelectionPlatformDefaultEnabled && !primarySelectionAlreadyDefaultedForPlatform
        const stampPrimarySelectionTerminalDefaults =
          primarySelectionPlatformDefaultEnabled && !primarySelectionDefaultedForTerminalDefaults
        if (migratePrimarySelectionPlatformDefault || stampPrimarySelectionTerminalDefaults) {
          this.loadNeedsSave = true
        }
        if (!visibleTaskProvidersDefaultedForJira) {
          this.loadNeedsSave = true
        }
        const claudeAgentTeamsDefaultDisabledMigrated =
          parsed.settings?.claudeAgentTeamsDefaultDisabledMigrated === true
        if (!claudeAgentTeamsDefaultDisabledMigrated) {
          this.loadNeedsSave = true
        }
        const migratedDisabledTuiAgents = normalizeDisabledTuiAgents(
          parsed.settings?.disabledTuiAgents
        )
        const migratedAgentYoloDefaults = migrateAgentYoloDefaults(parsed.settings)
        if (
          parsed.settings?.agentYoloDefaultsMigrated !== true ||
          hasUnsupportedTuiAgentArgs('opencode', parsed.settings?.agentDefaultArgs?.opencode) ||
          hasUnsupportedTuiAgentArgs('kilo', parsed.settings?.agentDefaultArgs?.kilo)
        ) {
          this.loadNeedsSave = true
        }
        if (
          !claudeAgentTeamsDefaultDisabledMigrated &&
          !migratedDisabledTuiAgents.includes('claude-agent-teams')
        ) {
          migratedDisabledTuiAgents.push('claude-agent-teams')
        }
        const migratedWindowsRuntimeDefault =
          parsed.settings?.localWindowsRuntimeDefault === undefined
            ? deriveGlobalWindowsRuntimeDefaultFromLegacySettings(parsed.settings).defaultRuntime
            : parsed.settings.localWindowsRuntimeDefault
        if (
          parsed.settings?.localWindowsRuntimeDefault === undefined &&
          migratedWindowsRuntimeDefault.kind === 'wsl'
        ) {
          this.loadNeedsSave = true
        }
        // Why (#9537): migrate the indistinguishable legacy host default once so WSL-default users follow their runtime.
        const localAccountRuntimeAlreadyMigrated =
          parsed.settings?.localAccountRuntimeDefaultedToAutoForAllUsers === true
        const migratedLocalAccountRuntime: GlobalSettings['localAccountRuntime'] =
          localAccountRuntimeAlreadyMigrated
            ? (parsed.settings?.localAccountRuntime ?? defaults.settings.localAccountRuntime)
            : parsed.settings?.localAccountRuntime === 'wsl'
              ? 'wsl'
              : 'auto'
        if (!localAccountRuntimeAlreadyMigrated) {
          this.loadNeedsSave = true
        }
        if (!autoRenameBranchFromWorkDefaultedOn) {
          this.loadNeedsSave = true
        }
        const normalizedOnboarding = normalizeLoadedOnboardingState(
          parsed.onboarding,
          defaults.onboarding
        )
        if (!parsed.onboarding) {
          this.loadNeedsSave = true
        }
        const normalizedProjectGroups = normalizeProjectGroups(parsed.projectGroups)
        const loadedCompactWorktreeCards =
          parsed.settings?.compactWorktreeCards ??
          parsed.settings?.experimentalCompactWorktreeCards ??
          defaults.settings.compactWorktreeCards
        const mobilePairingCustomAddress = normalizeMobilePairingCustomAddress(
          parsed.settings?.mobilePairingCustomAddress
        )
        const rawMobilePairingCustomAddresses = parsed.settings?.mobilePairingCustomAddresses
        const mobilePairingCustomAddresses = mobilePairingCustomAddress
          ? addMobilePairingCustomAddress(
              normalizeMobilePairingCustomAddresses(rawMobilePairingCustomAddresses),
              mobilePairingCustomAddress
            )
          : normalizeMobilePairingCustomAddresses(rawMobilePairingCustomAddresses)
        if (
          parsed.settings?.mobilePairingCustomAddress !== undefined &&
          parsed.settings.mobilePairingCustomAddress !== mobilePairingCustomAddress
        ) {
          this.loadNeedsSave = true
        }
        const customAddressesMatch =
          Array.isArray(rawMobilePairingCustomAddresses) &&
          rawMobilePairingCustomAddresses.length === mobilePairingCustomAddresses.length &&
          rawMobilePairingCustomAddresses.every(
            (address, index) => address === mobilePairingCustomAddresses[index]
          )
        if (
          (rawMobilePairingCustomAddresses !== undefined || mobilePairingCustomAddress !== null) &&
          !customAddressesMatch
        ) {
          this.loadNeedsSave = true
        }
        const normalizedNotifications = normalizeNotificationSettings(
          parsed.settings?.notifications
        )
        // Why: a type-flipped notification field is repaired in memory only; without a dirty mark the
        // bad value stays on disk and the repair reruns on every launch.
        if (
          persistedNotificationSettingsRepaired(
            parsed.settings?.notifications,
            normalizedNotifications
          )
        ) {
          this.loadNeedsSave = true
        }
        const normalizedSourceControlGroupOrder = normalizeSourceControlGroupOrder(
          parsed.settings?.sourceControlGroupOrder
        )
        if (
          parsed.settings?.sourceControlGroupOrder !== undefined &&
          parsed.settings.sourceControlGroupOrder !== normalizedSourceControlGroupOrder
        ) {
          this.loadNeedsSave = true
        }
        result = {
          ...defaults,
          ...parsed,
          featureInteractionTelemetryBuckets: normalizeFeatureInteractionTelemetryBuckets(
            parsed.featureInteractionTelemetryBuckets
          ),
          projectGroups: normalizedProjectGroups,
          repos: migratedExternalVisibility.repos,
          folderWorkspaces: normalizeFolderWorkspaces(
            parsed.folderWorkspaces,
            normalizedProjectGroups
          ),
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
          settings: {
            ...defaults.settings,
            // Why (#7977): keep persisted experimentalNewWorktreeCardStyle:true — v1.4.130's onboarding auto-wrote it as a plain boolean, so it's indistinguishable from a real opt-in; only the default changed.
            ...stripRetiredGlobalSettings(parsed.settings),
            worktreeVisibilityDefaults: migratedExternalVisibility.defaults,
            prBotAuthorOverrides: normalizePRBotAuthorOverrides(
              parsed.settings?.prBotAuthorOverrides
            ),
            // Why: v1.3.42 renamed the sidekick setting to pet; carry the old flag forward once so enabled users don't lose it.
            experimentalPet:
              parsed.settings?.experimentalPet ?? readLegacySidekickFlag(parsed) ?? false,
            // Why: early builds saved the disabled default; flip Linux/macOS profiles once to match platform, guards keep opt-outs.
            primarySelectionMiddleClickPaste: migratePrimarySelectionPlatformDefault
              ? true
              : (parsed.settings?.primarySelectionMiddleClickPaste ??
                defaults.settings.primarySelectionMiddleClickPaste),
            primarySelectionMiddleClickPasteDefaultedForLinux:
              primarySelectionDefaultedForLinux ||
              (process.platform === 'linux' && migratePrimarySelectionPlatformDefault),
            primarySelectionMiddleClickPasteDefaultedForTerminalDefaults:
              primarySelectionDefaultedForTerminalDefaults || stampPrimarySelectionTerminalDefaults,
            ...migratedAutoRenameBranchFromWork,
            ...migratedTerminalCursorStyle,
            terminalLineHeight: migratedTerminalLineHeight,
            // Why: the old true default was inherited, but false was always an explicit opt-out and must survive this one-shot reset.
            terminalRightClickToPaste: terminalRightClickToPasteDefaultedForPlatform
              ? (parsed.settings?.terminalRightClickToPaste ??
                defaults.settings.terminalRightClickToPaste)
              : parsed.settings?.terminalRightClickToPaste === false
                ? false
                : defaults.settings.terminalRightClickToPaste,
            terminalRightClickToPasteDefaultedForPlatform: true,
            ...migratedTerminalTuiScrollSensitivity.settings,
            experimentalActivity: migratedExperimentalActivity,
            experimentalActivityDefaultedOffForAllUsers: true,
            // Why: compact worktree cards graduated from Experimental; preserve the old opt-in for rollout-era profiles.
            compactWorktreeCards: loadedCompactWorktreeCards,
            experimentalCompactWorktreeCards: undefined,
            terminalMacOptionAsAlt: migratedOptionAsAlt,
            terminalMacOptionAsAltMigrated: true,
            localWindowsRuntimeDefault: migratedWindowsRuntimeDefault,
            localAccountRuntime: migratedLocalAccountRuntime,
            localAccountRuntimeDefaultedToAutoForAllUsers: true,
            ...migratedOsc52Clipboard,
            floatingTerminalEnabled: migratedFloatingTerminalEnabled,
            floatingTerminalDefaultedForAllUsers: true,
            floatingTerminalCwd: migratedFloatingTerminalCwd,
            floatingTerminalTrustedCwds: migratedFloatingTerminalTrustedCwds,
            floatingTerminalCwdMigratedToAppWorkspace: true,
            terminalScrollbackRows: migratedTerminalScrollback.rows,
            terminalQuickCommands: normalizeTerminalQuickCommands(
              parsed.settings?.terminalQuickCommands
            ),
            terminalCustomThemes: normalizeTerminalCustomThemes(
              parsed.settings?.terminalCustomThemes
            ),
            appIcon: normalizeAppIconId(parsed.settings?.appIcon),
            mobilePairingCustomAddress,
            mobilePairingCustomAddresses,
            // Why: persisted settings may be hand-edited or from older builds; keep tray-minimize false unless stored value is true.
            minimizeToTrayOnClose: parsed.settings?.minimizeToTrayOnClose === true,
            // Why: missing means default-on; round-trips unchanged on non-mac since darwin consumers gate the effect.
            showMenuBarIcon: parsed.settings?.showMenuBarIcon !== false,
            uiLanguage: normalizeUiLanguage(parsed.settings?.uiLanguage),
            defaultTaskSource: taskProviderSettings.defaultTaskSource,
            visibleTaskProviders: taskProviderSettings.visibleTaskProviders,
            visibleTaskProvidersDefaultedForJira: true,
            terminalShortcutPolicy: normalizeTerminalShortcutPolicy(
              parsed.settings?.terminalShortcutPolicy
            ),
            disabledTuiAgents: migratedDisabledTuiAgents,
            ...migratedAgentYoloDefaults,
            claudeAgentTeamsDefaultDisabledMigrated: true,
            openInApplications: normalizeOpenInApplications(parsed.settings?.openInApplications, {
              seedDefaults: true
            }),
            notifications: normalizedNotifications,
            sourceControlAi: migratedSourceControlAi,
            sourceControlGroupOrder: normalizedSourceControlGroupOrder,
            // Why: rollback builds still read commitMessageAi, so refresh the legacy projection from sourceControlAi for compat.
            commitMessageAi: projectSourceControlAiToLegacyCommitMessageAi(
              migratedSourceControlAi,
              parsed.settings?.commitMessageAi ?? defaults.settings.commitMessageAi
            ),
            voice: {
              ...getDefaultVoiceSettings(),
              ...parsed.settings?.voice
            }
          },
          // Why: legacy 'recent' meant the smart sort; migrate once on the raw value so a fresh 'recent' default isn't remigrated.
          ui: (() => {
            const rawSort = parsed.ui?.sortBy
            const sort = normalizeSortBy(rawSort)
            const migrate = !parsed.ui?._sortBySmartMigrated && rawSort === 'recent'
            const rightSidebarOpen =
              typeof parsed.ui?.rightSidebarOpen === 'boolean'
                ? parsed.ui.rightSidebarOpen
                : typeof parsed.settings?.rightSidebarOpenByDefault === 'boolean'
                  ? parsed.settings.rightSidebarOpenByDefault
                  : defaults.ui.rightSidebarOpen
            if (typeof parsed.ui?.rightSidebarOpen !== 'boolean') {
              this.loadNeedsSave = true
            }
            const workspaceStatusesDefaultOrderMigrated =
              parsed.ui?._workspaceStatusesDefaultOrderMigrated === true
            // Why: a short-lived default put Done on the left; repair only the exact raw payload once so user reorders survive.
            const workspaceStatusesReorderedDefaultRepaired =
              parsed.ui?._workspaceStatusesReorderedDefaultRepaired === true
            // Why: only exact legacy default payloads migrate; customized status labels/colors/icons/order are kept.
            const workspaceStatusesDefaultWorkflowMigrated =
              parsed.ui?._workspaceStatusesDefaultWorkflowMigrated === true
            // Why: visual migration has its own guard so later user choices of valid legacy color/icon IDs are preserved.
            const workspaceStatusesDefaultVisualsMigrated =
              parsed.ui?._workspaceStatusesDefaultVisualsMigrated === true
            const workspaceStatuses = normalizePersistedWorkspaceStatuses(
              parsed.ui?.workspaceStatuses,
              {
                migrateDefaultWorkflowStatuses: !workspaceStatusesDefaultWorkflowMigrated,
                repairReorderedDefaultStatuses: !workspaceStatusesReorderedDefaultRepaired,
                migrateLegacyDefaultStatusVisuals: !workspaceStatusesDefaultVisualsMigrated
              }
            )
            if (
              !workspaceStatusesDefaultOrderMigrated ||
              !workspaceStatusesReorderedDefaultRepaired ||
              !workspaceStatusesDefaultWorkflowMigrated ||
              !workspaceStatusesDefaultVisualsMigrated
            ) {
              this.loadNeedsSave = true
            }
            const rawCardProps = parsed.ui?.worktreeCardProperties
            const inlineAgentsMigrated = parsed.ui?._inlineAgentsDefaultedForAllUsers === true
            const expandedCardPropsMigrated =
              parsed.ui?._expandedWorktreeCardPropertiesDefaulted === true
            const jiraIssueCardPropDefaulted =
              parsed.ui?._jiraIssueWorktreeCardPropertyDefaulted === true
            const hadExperimentOn = readDeprecatedExperimentFlag(parsed)
            const deliberateUncheck =
              hadExperimentOn &&
              Array.isArray(rawCardProps) &&
              !rawCardProps.includes('inline-agents')
            const needsInlineAgentsMigration =
              !inlineAgentsMigrated &&
              !deliberateUncheck &&
              Array.isArray(rawCardProps) &&
              !rawCardProps.includes('inline-agents')
            const needsLegacyDefaultedCompactMigration =
              loadedCompactWorktreeCards &&
              parsed.ui?._worktreeCardModeDefaulted === true &&
              isDefaultedCompactWorktreeCardProperties(rawCardProps)
            const migratedCardProps = (() => {
              if (!Array.isArray(rawCardProps)) {
                return undefined
              }
              if (needsLegacyDefaultedCompactMigration) {
                return getWorktreeCardModeProperties('Compact')
              }
              const candidate = needsInlineAgentsMigration
                ? [...rawCardProps, 'inline-agents' as const]
                : rawCardProps
              const expandedCandidate = (() => {
                if (expandedCardPropsMigrated) {
                  return candidate
                }
                const next = [...candidate]
                // Why: Linear rode the 'issue' property and Ports were always shown; split them out once to preserve existing cards.
                if (candidate.includes('issue') && !candidate.includes('linear-issue')) {
                  next.push('linear-issue' as const)
                }
                if (!candidate.includes('ports')) {
                  next.push('ports' as const)
                }
                return next
              })()
              // Why: 'jira-issue' joined the defaults after the expansion migration already stamped upgraded profiles, so it needs its own one-shot backfill.
              const jiraCandidate =
                jiraIssueCardPropDefaulted || expandedCandidate.includes('jira-issue')
                  ? expandedCandidate
                  : [...expandedCandidate, 'jira-issue' as const]
              const normalized = normalizeWorktreeCardProperties(jiraCandidate)
              const changed =
                normalized.length !== rawCardProps.length ||
                normalized.some((property, index) => property !== rawCardProps[index])
              return changed ? normalized : undefined
            })()
            if (
              migratedCardProps !== undefined ||
              !inlineAgentsMigrated ||
              !expandedCardPropsMigrated ||
              !jiraIssueCardPropDefaulted
            ) {
              this.loadNeedsSave = true
            }
            const rawExplorerView = parsed.ui?.rightSidebarExplorerView
            const rightSidebarExplorerView = normalizeRightSidebarExplorerView(
              rawExplorerView,
              parsed.ui?.rightSidebarTab
            )
            // Why: without a dirty mark the legacy "Search tab, no explorer view" repair stays
            // in memory only, so a profile that never writes again redoes it on every launch.
            if (
              rawExplorerView === undefined
                ? rightSidebarExplorerView !== defaults.ui.rightSidebarExplorerView
                : rawExplorerView !== rightSidebarExplorerView
            ) {
              this.loadNeedsSave = true
            }
            const setupGuideSidebarDismissed = resolveSetupGuideSidebarDismissedOnLoad(
              parsed.ui?.setupGuideSidebarDismissed,
              normalizedOnboarding
            )
            if (
              parsed.ui?.setupGuideSidebarDismissed !== setupGuideSidebarDismissed &&
              (setupGuideSidebarDismissed || parsed.ui?.setupGuideSidebarDismissed !== undefined)
            ) {
              this.loadNeedsSave = true
            }
            // Why: only upgraded profiles still on the new default get the one-time usage-display notice; fresh profiles stay quiet.
            const usagePercentageDisplayChangeNoticeDismissed =
              resolveUsagePercentageDisplayChangeNoticeDismissed({
                rawDismissed: parsed.ui?.usagePercentageDisplayChangeNoticeDismissed,
                rawUsagePercentageDisplay: parsed.ui?.usagePercentageDisplay,
                isExistingProfile: isExistingPersistedProfile({
                  repoCount: parsed.repos?.length ?? 0,
                  onboardingClosedAt: normalizedOnboarding.closedAt,
                  ui: parsed.ui
                })
              })
            if (
              parsed.ui?.usagePercentageDisplayChangeNoticeDismissed !==
              usagePercentageDisplayChangeNoticeDismissed
            ) {
              this.loadNeedsSave = true
            }
            return {
              ...defaults.ui,
              // Why: missing card properties follow the persisted layout mode; explicit choices are preserved below.
              worktreeCardProperties: getWorktreeCardModeProperties(
                loadedCompactWorktreeCards ? 'Compact' : 'Default'
              ),
              ...stripMainOwnedTelemetryMarkerFromUI(parsed.ui),
              // Why: migrate once from the retired Appearance setting only when no explicit chrome preference exists yet.
              rightSidebarOpen,
              rightSidebarTab: normalizeRightSidebarTab(parsed.ui?.rightSidebarTab),
              // Why here and not in getPersistedUI: only the raw payload still shows the legacy
              // "Search tab, no explorer view" shape — the defaults spread above fills in 'files'.
              rightSidebarExplorerView,
              setupGuideSidebarDismissed,
              usagePercentageDisplayChangeNoticeDismissed,
              setupGuideBrowserMilestoneMigrated:
                typeof parsed.ui?.setupGuideBrowserMilestoneMigrated === 'boolean'
                  ? parsed.ui.setupGuideBrowserMilestoneMigrated
                  : false,
              setupGuideBrowserMilestoneLegacyComplete:
                parsed.ui?.setupGuideBrowserMilestoneLegacyComplete === true,
              // Why persist rather than notify inline: the flip lands during load, before any
              // window exists, and it must survive a crash before the user ever sees the notice.
              osc52ClipboardDefaultOnNoticePending: osc52ClipboardNoticePending,
              sortBy: migrate ? ('smart' as const) : sort,
              showDotfilesByWorktree: normalizeShowDotfilesByWorktree(
                parsed.ui?.showDotfilesByWorktree
              ),
              workspaceStatuses,
              _workspaceStatusesDefaultOrderMigrated: true,
              _workspaceStatusesReorderedDefaultRepaired: true,
              _workspaceStatusesDefaultWorkflowMigrated: true,
              _workspaceStatusesDefaultVisualsMigrated: true,
              _sortBySmartMigrated: true,
              ...(migratedCardProps !== undefined
                ? { worktreeCardProperties: migratedCardProps }
                : {}),
              // Why: keep stamping the legacy flag for rollback forward-compat; the new flag actually gates the migration.
              _inlineAgentsDefaultedForExperiment: true,
              _inlineAgentsDefaultedForAllUsers: true,
              _expandedWorktreeCardPropertiesDefaulted: true,
              _jiraIssueWorktreeCardPropertyDefaulted: true
            }
          })(),
          // Why: volatile schema; zod-validate workspaceSession at read so a bad payload falls to defaults, not a renderer crash.
          workspaceSession: (() => {
            if (parsed.workspaceSession === undefined) {
              return defaults.workspaceSession
            }
            const result = parseWorkspaceSessionSalvaging(parsed.workspaceSession)
            if (!result.ok) {
              console.error(
                '[persistence] Corrupt workspace session, using defaults:',
                result.error
              )
              return defaults.workspaceSession
            }
            if (result.droppedCount > 0) {
              console.warn(
                '[persistence] Salvaged workspace session; dropped corrupt entries:',
                workspaceSessionSalvageLogDetails(result)
              )
              // Why: salvage repairs only the in-memory session; without a save the corrupt entries stay on disk and get re-dropped every launch.
              this.loadNeedsSave = true
            }
            return { ...defaults.workspaceSession, ...result.value }
          })(),
          // Why: per-host session partitions, validated independently; 'local' stays in workspaceSession for downgrade compat.
          workspaceSessionsByHostId: (() => {
            const { partitions, repaired } = parseWorkspaceSessionsByHostId(
              parsed.workspaceSessionsByHostId,
              defaults.workspaceSession
            )
            if (repaired) {
              // Why: salvage repairs only the in-memory partitions; without a save the corrupt entries stay on disk and get re-dropped every launch.
              this.loadNeedsSave = true
            }
            return partitions
          })(),
          sshTargets: (parsed.sshTargets ?? []).map(normalizeSshTarget),
          deletedSshConfigAliases: Array.isArray(parsed.deletedSshConfigAliases)
            ? parsed.deletedSshConfigAliases.filter(
                (alias): alias is string => typeof alias === 'string'
              )
            : [],
          retiredWorktreeNamesByRepo: normalizeRetiredNameRegistryMap(
            parsed.retiredWorktreeNamesByRepo
          ),
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
          legacyPaneKeyAliasEntries: normalizeLegacyPaneKeyAliasEntries(
            parsed.legacyPaneKeyAliasEntries
          ),
          automations: Array.isArray(parsed.automations) ? parsed.automations : [],
          automationRuns: (() => {
            if (!Array.isArray(parsed.automationRuns)) {
              return []
            }
            const runs = pruneAutomationRuns(backfillAutomationRunNumbers(parsed.automationRuns))
            // Why: nothing else marks dirty, so an oversized legacy file would otherwise only shrink at the next unrelated save.
            if (runs.length !== parsed.automationRuns.length) {
              this.loadNeedsSave = true
            }
            return runs
          })(),
          onboarding: normalizedOnboarding
        }
      }
    } catch (err) {
      console.error('[persistence] Failed to load primary state, trying backups:', err)
    }

    // Corrupt-file and no-file paths converge here; a corrupted install counts as existing, so it sees the opt-in banner.
    if (result === null && allowBackupRecovery) {
      let hasBackup = false
      for (let i = 0; i < BACKUP_COUNT; i++) {
        if (existsSync(backupPath(dataFile, i))) {
          hasBackup = true
          break
        }
      }
      if (fileExistedOnLoad || hasBackup) {
        if (this.restoreFromBackup(dataFile)) {
          return this.load(false)
        }
        console.error('[persistence] No usable state file or backup found, using defaults')
      }
    }

    if (result === null) {
      result = getDefaultPersistedState(homedir())
    }

    const workspaceSession = pruneWorkspaceSessionBrowserHistory(
      pruneLocalTerminalScrollbackBuffers(result.workspaceSession, result.repos)
    )
    const migratedScrollback = migrateWorkspaceSessionTerminalScrollbackSnapshots(
      workspaceSession,
      this.terminalScrollbackSnapshotStorage
    )
    if (migratedScrollback.changed) {
      this.loadNeedsSave = true
    }

    const repos = clearMissingProjectGroupMemberships(result.repos, result.projectGroups ?? [])
    const projectHostSetupCompatibility = mergeProjectHostSetupCompatibilityState(result, repos)
    if (!projectHostSetupCompatibilityStateEqual(result, projectHostSetupCompatibility)) {
      this.loadNeedsSave = true
    }

    const automationContextMigration = backfillLegacyAutomationContexts({
      ...result,
      repos,
      ...projectHostSetupCompatibility
    })
    if (automationContextMigration.changed) {
      this.loadNeedsSave = true
    }
    result = {
      ...result,
      automations: automationContextMigration.state.automations,
      automationRuns: automationContextMigration.state.automationRuns
    }

    const folderScopeConnectionMigration = backfillFolderScopeConnectionIds({
      ...result,
      repos,
      ...projectHostSetupCompatibility,
      workspaceSession: migratedScrollback.session
    })
    if (folderScopeConnectionMigration.changed) {
      this.loadNeedsSave = true
    }
    result = folderScopeConnectionMigration.state

    if (normalizeWorktreeLinkedItemMetadata(result)) {
      this.loadNeedsSave = true
    }

    if (gcStaleWorktreeMeta(result) > 0) {
      this.loadNeedsSave = true
    }

    const migrated = this.migrateTabSwitchKeybindings(
      this.migrateTelemetry(result, fileExistedOnLoad),
      fileExistedOnLoad
    )

    // githubCache is a sidecar file now (see getGithubCacheFile); legacy in-file caches seed the session, then get stripped.
    const legacyCache = migrated.githubCache
    const hasLegacyCache =
      Object.keys(legacyCache?.pr ?? {}).length > 0 ||
      Object.keys(legacyCache?.issue ?? {}).length > 0
    if (hasLegacyCache) {
      this.loadNeedsSave = true
      // Why: mark dirty so the first flush writes the sidecar even without a poll refresh this session, preserving the seed.
      this.githubCacheDirty = true
    } else {
      migrated.githubCache = readGithubCacheSnapshot(this.dataFile) ?? migrated.githubCache
    }

    logPersistenceStartupMilestone('persistence-load-done', {
      repos: migrated.repos.length,
      workspaceSessionBytes: Buffer.byteLength(JSON.stringify(migrated.workspaceSession))
    })
    return migrated
  }

  // One-shot telemetry cohort migration: seeds existedBeforeTelemetryRelease, optedIn, and installId (no-op once set).
  // One-shot tab-switch cohort freeze: fileExistedOnLoad tells existing vs fresh only on the first launch, so persist now.
  private migrateTabSwitchKeybindings(
    state: PersistedState,
    fileExistedOnLoad: boolean
  ): PersistedState {
    const existing = state.settings?.tabSwitchKeybindingSeed
    if (existing === 'pending' || existing === 'done') {
      return state
    }
    // Why: mark dirty so the frozen cohort persists; else a fresh install re-reads as "existing" after its file lands.
    this.loadNeedsSave = true
    return {
      ...state,
      settings: {
        ...state.settings,
        // Existing installs pin old chords via a keybindings.json seed; fresh installs use the new registry defaults.
        tabSwitchKeybindingSeed: fileExistedOnLoad ? 'pending' : 'done'
      }
    }
  }

  private migrateTelemetry(state: PersistedState, fileExistedOnLoad: boolean): PersistedState {
    const existing = state.settings?.telemetry
    // Why: require all three invariants; keying on existedBeforeTelemetryRelease alone lets a partial block skip migration.
    if (
      typeof existing?.existedBeforeTelemetryRelease === 'boolean' &&
      typeof existing.installId === 'string' &&
      existing.installId.length > 0 &&
      (existing.optedIn === true || existing.optedIn === false || existing.optedIn === null)
    ) {
      return state
    }
    // Why: resolve cohort once; re-inferring it in the optedIn fallback could misclassify a partially-written new user.
    const resolvedExistedBefore =
      typeof existing?.existedBeforeTelemetryRelease === 'boolean'
        ? existing.existedBeforeTelemetryRelease
        : fileExistedOnLoad
    return {
      ...state,
      settings: {
        ...state.settings,
        telemetry: {
          ...existing,
          existedBeforeTelemetryRelease: resolvedExistedBefore,
          // Why: preserve any explicit opt-in/out; fall back to cohort default only when optedIn is undefined, never when false.
          optedIn:
            existing?.optedIn === true || existing?.optedIn === false || existing?.optedIn === null
              ? existing.optedIn
              : resolvedExistedBefore
                ? null
                : true,
          installId:
            typeof existing?.installId === 'string' && existing.installId.length > 0
              ? existing.installId
              : randomUUID()
        }
      }
    }
  }

  // Why 1s trailing + 5s max-wait (was 300ms unbounded): coalesce mutation bursts; max-wait bounds crash staleness at 5s.
  private static SAVE_DEBOUNCE_MS = 1_000
  private static SAVE_MAX_WAIT_MS = 5_000

  private scheduleSave(): void {
    // Why: once the quit flush has snapshotted, a newly debounced write would fire during
    // teardown with nothing awaiting it, and the process can exit mid-rename. The quit
    // flush is the last write by construction.
    if (this.quitFlushStarted) {
      return
    }
    this.writeGeneration += 1
    const now = Date.now()
    this.firstPendingSaveAt ??= now
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
    }
    const untilMaxWait = Math.max(0, this.firstPendingSaveAt + Store.SAVE_MAX_WAIT_MS - now)
    const delay = Math.min(Store.SAVE_DEBOUNCE_MS, untilMaxWait)
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      this.firstPendingSaveAt = null
      void this.enqueueWrite()
    }, delay)
  }

  private enqueueWrite(): Promise<void> {
    const previousWrite = Promise.all([
      this.pendingWrite ?? this.staleTempCleanup,
      this.pendingSnapshotFileWork ?? Promise.resolve()
    ]).then(() => {})
    const write = previousWrite.then(() => this.writeToDiskAsync())
    const trackedWrite = write
      .catch((err) => {
        console.error('[persistence] Failed to write state:', err)
      })
      .finally(() => {
        if (this.pendingWrite === trackedWrite) {
          this.pendingWrite = null
        }
      })
    this.pendingWrite = trackedWrite
    return write
  }

  /** Wait for any in-flight async disk write to complete. Used in tests. */
  async waitForPendingWrite(): Promise<void> {
    await Promise.all([this.pendingWrite, this.activeViewPreference.waitForPendingWrite()])
  }

  // Why githubCache is omitted: memory-only this session (see getGithubCacheFile), so refreshes never touch the durable file.
  private getDurableState(): Omit<PersistedState, 'githubCache'> {
    const { githubCache: _memoryOnly, ...durable } = this.state
    return durable
  }

  // Why: build payload synchronously so hash and bytes reflect one state tick. A degraded prefix makes the first healthy retry durable even when plaintext state is unchanged.
  private buildStateToSave(): {
    payload: string
    stateHash: string
    protectedSecretUpdates: ProtectedSecretRetentionUpdate[]
  } {
    // Why sentinels (not a blob/key string match): the substitution must be
    // position-exact. A plain search for the ciphertext — or even for a
    // `"key":"blob"` token — can be mimicked by user-controlled state (e.g. an
    // agentDefaultEnv var named after a secret field, or a value equal to a
    // ciphertext), which would substitute the wrong site and let two DISTINCT
    // states normalize equal → a silently dropped write (data loss), reachable
    // on deterministic-IV platforms (macOS/legacy-Linux OSCrypt). A per-slot
    // random UUID can't occur anywhere else in the serialized state (the user
    // sets their data before it is minted), so it appears exactly once.
    const secretSubs: { sentinel: string; blob: string; hashValue: string }[] = []
    const protectedSecretUpdates: ProtectedSecretRetentionUpdate[] = []
    let protectedStorageDegraded = false
    const encryptToSentinel = (slot: string, plaintext: string): string => {
      const encrypted = this.protectedSecrets.encrypt(slot, plaintext)
      if (encrypted.retentionUpdate) {
        protectedSecretUpdates.push(encrypted.retentionUpdate)
      }
      protectedStorageDegraded ||= encrypted.degraded
      const { blob, hashValue = plaintext } = encrypted
      // Values already identical in payload and hash need no sentinel substitution.
      if (blob === plaintext && hashValue === plaintext) {
        return blob
      }
      const sentinel = `orca-secret-slot-${randomUUID()}`
      secretSubs.push({ sentinel, blob, hashValue })
      return sentinel
    }
    const encryptOptionalToSentinel = (
      slot: string,
      plaintext: string | null | undefined
    ): string | null => {
      const encrypted = encryptToSentinel(slot, plaintext ?? '')
      return encrypted || null
    }
    // Why: clone before encrypting secrets so in-memory this.state stays plaintext.
    const stateToSave = {
      ...this.getDurableState(),
      // Why both keys unconditionally: the explicit keys always win over the spread, and
      // JSON.stringify drops the `undefined` value so a note-free profile gains no key on disk.
      // The strip builds a new array here only; this.state records keep their notes in memory.
      folderWorkspaces: (this.state.folderWorkspaces ?? []).map(
        ({ diffComments: _relocated, ...rest }) => rest
      ),
      folderWorkspaceDiffComments: collectFolderWorkspaceDiffComments(this.state.folderWorkspaces),
      sshPtyConsumerRecoveries: (this.state.sshPtyConsumerRecoveries ?? []).map((record) => ({
        ...record,
        ownerLease: encryptToSentinel(
          sshPtyOwnerLeaseSecretSlot(record.targetId),
          record.ownerLease
        )
      })),
      settings: {
        ...stripRetiredGlobalSettings(this.state.settings),
        opencodeSessionCookie: encryptToSentinel(
          PROTECTED_SECRET_SLOT.opencodeSessionCookie,
          this.state.settings.opencodeSessionCookie
        ),
        httpProxyUrl: encryptToSentinel(
          PROTECTED_SECRET_SLOT.httpProxyUrl,
          this.state.settings.httpProxyUrl ?? ''
        )
      },
      ui: {
        ...this.state.ui,
        browserKagiSessionLink: encryptOptionalToSentinel(
          PROTECTED_SECRET_SLOT.browserKagiSessionLink,
          this.state.ui.browserKagiSessionLink
        )
      }
    }
    // Why compact: ~20% fewer bytes and less serialize time; all readers JSON.parse so formatting is irrelevant.
    // One full-state stringify; secret slots currently hold sentinels.
    const serialized = JSON.stringify(stateToSave)
    // Substitute each unique sentinel exactly once: ciphertext for the on-disk
    // payload, a stable normalized value for the guard hash. Function-form
    // replacement keeps `$` inert; both sides read the sentinel as JSON-escaped
    // in `serialized`, so each replace is byte-for-byte position-exact.
    let payload = serialized
    let hashInput = serialized
    for (const { sentinel, blob, hashValue } of secretSubs) {
      const escapedSentinel = JSON.stringify(sentinel).slice(1, -1)
      payload = payload.replace(escapedSentinel, () => JSON.stringify(blob).slice(1, -1))
      hashInput = hashInput.replace(escapedSentinel, () => JSON.stringify(hashValue).slice(1, -1))
    }
    const stateHash = createHash('sha1')
      .update(protectedStorageDegraded ? 'safeStorage-degraded\0' : '')
      .update(hashInput)
      .digest('hex')
    return { payload, stateHash, protectedSecretUpdates }
  }

  // Why: async writes avoid blocking the main Electron thread on every debounced save.
  private async writeToDiskAsync(): Promise<void> {
    if (this.writesFrozen) {
      return
    }
    const gen = this.writeGeneration
    const { payload, stateHash, protectedSecretUpdates } = this.buildStateToSave()
    // Why: don't rewrite a byte-identical multi-MB file when state nets out to already-persisted.
    if (stateHash === this.lastWrittenStateHash) {
      this.lastDurableWriteGeneration = Math.max(this.lastDurableWriteGeneration, gen)
      return
    }
    const dataFile = this.dataFile
    const dir = dirname(dataFile)
    await mkdir(dir, { recursive: true }).catch(() => {})
    const tmpFile = durableWriteTempPath(dataFile)

    // Why: on any write/rename failure, remove the tmp file so it doesn't leave a multi-MB orphan.
    let renamed = false
    try {
      // Why: fsync before rename, then fsync the directory; see writeFileDurable.
      const handle = await open(tmpFile, 'w')
      try {
        await handle.writeFile(payload, 'utf-8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      // Why: if flush() bumped writeGeneration mid-write, it already wrote fresher state; don't overwrite it.
      if (this.writeGeneration !== gen) {
        return
      }
      this.inFlightAsyncTmpFile = tmpFile
      try {
        await renameDurable(tmpFile, dataFile)
        renamed = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || this.writeGeneration === gen) {
          throw error
        }
      } finally {
        if (this.inFlightAsyncTmpFile === tmpFile) {
          this.inFlightAsyncTmpFile = null
        }
      }
      // Why re-check gen: a mutation or sync flush during rename makes the installed hash ambiguous; invalidate the no-op guard.
      if (renamed && this.writeGeneration === gen) {
        this.lastWrittenStateHash = stateHash
        this.protectedSecrets.commitRetentionUpdates(protectedSecretUpdates)
      } else if (renamed) {
        this.lastWrittenStateHash = null
      }
      if (renamed) {
        this.lastDurableWriteGeneration = Math.max(this.lastDurableWriteGeneration, gen)
      }
    } finally {
      if (!renamed) {
        await rm(tmpFile).catch(() => {})
      }
    }
    if (!renamed) {
      return
    }
    // Why (#1158): rotate only after the primary rename while this write still owns its generation.
    if (this.writeGeneration !== gen) {
      return
    }
    await this.rotateBackupsAsync(dataFile)
  }

  // Why: sync variant only for flush() at shutdown, where the process may exit before an async write completes.
  private writeToDiskSync(opts: { force?: boolean; skipBackupRotation?: boolean } = {}): void {
    if (this.writesFrozen) {
      return
    }
    const { payload, stateHash, protectedSecretUpdates } = this.buildStateToSave()
    // Why: matching hash means the file already holds this state; force overrides when an async rename may be racing past the gen check.
    if (!opts.force && stateHash === this.lastWrittenStateHash) {
      return
    }
    const dataFile = this.dataFile
    const dir = dirname(dataFile)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    const tmpFile = `${dataFile}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`

    // Why: on any write/rename failure, remove the tmp file so shutdown crashes don't leak orphans.
    let renamed = false
    try {
      // Why: fsync the temp file and the directory; a bare rename can survive as stale or empty
      // content after power loss, losing projects/tabs back to the newest usable .bak slot.
      writeFileDurableSync(tmpFile, dataFile, payload)
      renamed = true
      this.lastWrittenStateHash = stateHash
      this.protectedSecrets.commitRetentionUpdates(protectedSecretUpdates)
      this.lastDurableWriteGeneration = Math.max(
        this.lastDurableWriteGeneration,
        this.writeGeneration
      )
    } finally {
      if (!renamed) {
        try {
          unlinkSync(tmpFile)
        } catch {
          // Best-effort cleanup; the write already failed, swallow secondary error.
        }
      }
    }
    const now = Date.now()
    if (!opts.skipBackupRotation && this.shouldRotateBackups(now, dataFile)) {
      this.rotateBackupsSync(dataFile)
    }
  }

  flushOrThrow(): void {
    if (this.quitFlushStarted) {
      throw new Error('Cannot synchronously flush after final persistence has started')
    }
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    this.firstPendingSaveAt = null
    const asyncWriteWasInFlight = this.pendingWrite !== null
    // Why: bump writeGeneration so an in-flight async write skips its rename and can't overwrite this sync write.
    this.writeGeneration++
    if (this.inFlightAsyncTmpFile) {
      try {
        unlinkSync(this.inFlightAsyncTmpFile)
        this.inFlightAsyncTmpFile = null
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          void this.enqueueWrite().catch(() => {})
          throw error
        }
      }
    }
    // Why: later async flushes must remain serialized behind the invalidated writer.
    this.writeToDiskSync({
      force: asyncWriteWasInFlight,
      skipBackupRotation: this.backupRotationInFlight
    })
  }

  flushActiveViewPreferenceOrThrow(): void {
    this.activeViewPreference.flushOrThrow()
  }

  getCodexResetCreditAttemptLedger(): CodexResetCreditAttemptLedger {
    return parseCodexResetCreditAttemptLedger(this.state.codexResetCreditAttemptLedger)
  }

  replaceCodexResetCreditAttemptLedgerAndFlush(ledger: CodexResetCreditAttemptLedger): void {
    if (this.writesFrozen) {
      throw new Error('Cannot persist Codex reset-credit attempts while writes are frozen')
    }
    const next = parseCodexResetCreditAttemptLedger(ledger)
    const previous = this.state.codexResetCreditAttemptLedger
      ? structuredClone(this.state.codexResetCreditAttemptLedger)
      : undefined
    this.state.codexResetCreditAttemptLedger = next
    try {
      this.flushOrThrow()
    } catch (error) {
      // Why: callers use a successful return as the durability barrier before
      // handing a scarce-credit mutation to the provider.
      this.state.codexResetCreditAttemptLedger = previous
      throw error
    }
  }

  // ── Repos ──────────────────────────────────────────────────────────

  getProfileStorageDirectory(): string {
    return dirname(this.dataFile)
  }

  private projectHostOperations: ProjectHostPersistenceOperations | null = null

  private getProjectHostOperations(): ProjectHostPersistenceOperations {
    this.projectHostOperations ??= new ProjectHostPersistenceOperations({
      state: this.state,
      gitUsernameCache: this.gitUsernameCache,
      hydrateRepo: (repo) => this.hydrateRepo(repo),
      updateRepoBackedProjectHostSetup: (setup, repo, updates) =>
        this.updateRepoBackedProjectHostSetup(setup, repo, updates),
      updateIndependentProjectHostSetup: (setup, updates) =>
        this.updateIndependentProjectHostSetup(setup, updates),
      removeProjectForHost: (id, hostId) => this.removeProjectForHost(id, hostId),
      scheduleSave: () => this.scheduleSave()
    })
    return this.projectHostOperations
  }

  getRepos(): Repo[] {
    return this.getProjectHostOperations().getRepos()
  }

  getProjects(): Project[] {
    return this.getProjectHostOperations().getProjects()
  }

  updateProject(id: string, updates: ProjectUpdateArgs['updates']): Project | null {
    return this.getProjectHostOperations().updateProject(id, updates)
  }

  getProjectHostSetups(): ProjectHostSetup[] {
    return this.getProjectHostOperations().getProjectHostSetups()
  }

  createProjectHostSetup(args: ProjectHostSetupCreateArgs): ProjectHostSetupCreateResult | null {
    return this.getProjectHostOperations().createProjectHostSetup(args)
  }

  updateProjectHostSetup(args: ProjectHostSetupUpdateArgs): ProjectHostSetupUpdateResult | null {
    return this.getProjectHostOperations().updateProjectHostSetup(args)
  }

  deleteProjectHostSetup(args: ProjectHostSetupDeleteArgs): ProjectHostSetupDeleteResult | null {
    return this.getProjectHostOperations().deleteProjectHostSetup(args)
  }

  getRepoCount(): number {
    return this.getProjectHostOperations().getRepoCount()
  }

  getRepo(id: string): Repo | undefined {
    return this.getProjectHostOperations().getRepo(id)
  }

  setResolvedRepoGitUsername(
    target: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>,
    username: string
  ): boolean {
    return this.getProjectHostOperations().setResolvedRepoGitUsername(target, username)
  }

  private projectGroupOperations: ProjectGroupPersistenceOperations | null = null

  private getProjectGroupOperations(): ProjectGroupPersistenceOperations {
    this.projectGroupOperations ??= new ProjectGroupPersistenceOperations({
      state: this.state,
      scheduleSave: () => this.scheduleSave(),
      removeWorkspaceLineageForFolderParent: (folderWorkspaceId) =>
        this.removeWorkspaceLineageForFolderParent(folderWorkspaceId),
      pruneMobileClientTabSelections: (matchesWorktreeId) =>
        this.pruneMobileClientTabSelections(matchesWorktreeId)
    })
    return this.projectGroupOperations
  }

  getProjectGroups(): ProjectGroup[] {
    return this.getProjectGroupOperations().getProjectGroups()
  }

  createProjectGroup(
    input: Parameters<ProjectGroupPersistenceOperations['createProjectGroup']>[0]
  ): ProjectGroup {
    return this.getProjectGroupOperations().createProjectGroup(input)
  }

  updateProjectGroup(
    groupId: string,
    updates: Parameters<ProjectGroupPersistenceOperations['updateProjectGroup']>[1]
  ): ProjectGroup | null {
    return this.getProjectGroupOperations().updateProjectGroup(groupId, updates)
  }

  deleteProjectGroup(groupId: string): boolean {
    return this.getProjectGroupOperations().deleteProjectGroup(groupId)
  }

  private folderWorkspaceOperations: FolderWorkspacePersistenceOperations | null = null

  private getFolderWorkspaceOperations(): FolderWorkspacePersistenceOperations {
    this.folderWorkspaceOperations ??= new FolderWorkspacePersistenceOperations({
      state: this.state,
      scheduleSave: () => this.scheduleSave(),
      removeWorkspaceLineageForFolderParent: (folderWorkspaceId) =>
        this.removeWorkspaceLineageForFolderParent(folderWorkspaceId),
      pruneMobileClientTabSelections: (matchesWorktreeId) =>
        this.pruneMobileClientTabSelections(matchesWorktreeId),
      hydrateRepo: (repo) => this.hydrateRepo(repo)
    })
    return this.folderWorkspaceOperations
  }

  getFolderWorkspaces(): FolderWorkspace[] {
    return this.getFolderWorkspaceOperations().getFolderWorkspaces()
  }

  getFolderWorkspace(id: string): FolderWorkspace | undefined {
    return this.getFolderWorkspaceOperations().getFolderWorkspace(id)
  }

  createFolderWorkspace(
    input: Parameters<FolderWorkspacePersistenceOperations['createFolderWorkspace']>[0]
  ): FolderWorkspace {
    return this.getFolderWorkspaceOperations().createFolderWorkspace(input)
  }

  updateFolderWorkspace(
    id: string,
    updates: Parameters<FolderWorkspacePersistenceOperations['updateFolderWorkspace']>[1]
  ): FolderWorkspace | null {
    return this.getFolderWorkspaceOperations().updateFolderWorkspace(id, updates)
  }

  removeFolderWorkspace(id: string): boolean {
    return this.getFolderWorkspaceOperations().removeFolderWorkspace(id)
  }

  moveProjectToGroup(repoId: string, groupId: string | null, order?: number): Repo | null {
    return this.getFolderWorkspaceOperations().moveProjectToGroup(repoId, groupId, order)
  }

  private repoOrderOperations: RepoOrderPersistenceOperations | null = null

  private getRepoOrderOperations(): RepoOrderPersistenceOperations {
    this.repoOrderOperations ??= new RepoOrderPersistenceOperations({
      state: this.state,
      syncProjectHostSetupCompatibilityState: () => this.syncProjectHostSetupCompatibilityState(),
      scheduleSave: () => this.scheduleSave()
    })
    return this.repoOrderOperations
  }

  addRepo(repo: Repo): void {
    this.getRepoOrderOperations().addRepo(repo)
  }

  reorderRepos(orderedIds: string[]): boolean {
    return this.getRepoOrderOperations().reorderRepos(orderedIds)
  }

  reorderReposForHost(orderedIds: string[], hostId: ExecutionHostId): boolean {
    return this.getRepoOrderOperations().reorderReposForHost(orderedIds, hostId)
  }

  removeProject(id: string): void {
    this.state.repos = this.state.repos.filter((r) => r.id !== id)
    this.syncProjectHostSetupCompatibilityState()
    // Why: presets are repo-scoped and unreachable once the repo is gone, so drop them with it.
    delete this.state.sparsePresetsByRepo[id]
    delete this.state.retiredWorktreeNamesByRepo?.[id]
    this.pruneWorktreeStateForRepo(id, null)
    this.state.workspaceSession = removeRepoFromWorkspaceSession(this.state.workspaceSession, id)
    this.state.workspaceSessionsByHostId = removeRepoFromHostWorkspaceSessions(
      this.state.workspaceSessionsByHostId,
      id
    )
    this.scheduleSave()
  }

  // Why: the same repo id can exist on multiple execution hosts; remove only this host's row and metadata, never another host's.
  removeProjectForHost(id: string, hostId: ExecutionHostId): void {
    this.state.repos = this.state.repos.filter(
      (r) => !(r.id === id && getRepoExecutionHostId(r) === hostId)
    )
    const idStillPresent = this.state.repos.some((r) => r.id === id)
    // Why: presets and retirements are repo-id-scoped (not host-scoped); drop them only when the last host's copy is gone.
    if (!idStillPresent) {
      delete this.state.sparsePresetsByRepo[id]
      delete this.state.retiredWorktreeNamesByRepo?.[id]
    }
    this.syncProjectHostSetupCompatibilityState()
    // Why: prune only this host's worktree metas if the id survives elsewhere; otherwise prune everything (matches removeProject).
    this.pruneWorktreeStateForRepo(id, idStillPresent ? hostId : null)
    if (!idStillPresent) {
      this.state.workspaceSession = removeRepoFromWorkspaceSession(this.state.workspaceSession, id)
      this.state.workspaceSessionsByHostId = removeRepoFromHostWorkspaceSessions(
        this.state.workspaceSessionsByHostId,
        id
      )
    } else if (parseExecutionHostId(hostId)?.kind === 'runtime') {
      const session = this.state.workspaceSessionsByHostId?.[hostId]
      if (session) {
        this.state.workspaceSessionsByHostId = {
          ...this.state.workspaceSessionsByHostId,
          [hostId]: removeRepoFromWorkspaceSession(session, id)
        }
      }
    }
    this.scheduleSave()
  }

  // Prune worktree meta/lineage for a repo id; hostId null prunes all entries, else only that host's (missing meta.hostId = local).
  private pruneWorktreeStateForRepo(id: string, hostId: ExecutionHostId | null): void {
    pruneWorktreeStateForRepoOperation(this.state, id, hostId, (matchesWorktreeId) =>
      this.pruneMobileClientTabSelections(matchesWorktreeId)
    )
  }

  private pruneMobileClientTabSelections(matchesWorktreeId: (worktreeId: string) => boolean): void {
    for (const [clientNavigationId, selectionsByWorktree] of Object.entries(
      this.state.mobileClientTabSelectionsByDeviceId ?? {}
    )) {
      for (const worktreeId of Object.keys(selectionsByWorktree)) {
        if (matchesWorktreeId(worktreeId)) {
          delete selectionsByWorktree[worktreeId]
        }
      }
      if (Object.keys(selectionsByWorktree).length === 0) {
        delete this.state.mobileClientTabSelectionsByDeviceId?.[clientNavigationId]
      }
    }
  }

  private repoUpdateOperations: RepoUpdatePersistenceOperations | null = null

  private getRepoUpdateOperations(): RepoUpdatePersistenceOperations {
    this.repoUpdateOperations ??= new RepoUpdatePersistenceOperations({
      state: this.state,
      syncProjectHostSetupCompatibilityState: () => this.syncProjectHostSetupCompatibilityState(),
      scheduleSave: () => this.scheduleSave(),
      hydrateRepo: (repo) => this.hydrateRepo(repo)
    })
    return this.repoUpdateOperations
  }

  updateRepo(
    id: string,
    updates: Partial<
      Pick<
        Repo,
        | 'displayName'
        | 'badgeColor'
        | 'repoIcon'
        | 'upstream'
        | 'gitRemoteIdentity'
        | 'hookSettings'
        | 'worktreeBaseRef'
        | 'worktreeBasePath'
        | 'kind'
        | 'executionHostId'
        | 'symlinkPaths'
        | 'issueSourcePreference'
        | 'forkSyncMode'
        | 'externalWorktreeVisibilityPromptDismissedAt'
        | 'externalWorktreeInboxBaselinePaths'
        | 'importedExternalWorktreePaths'
        | 'customWorktreeVisibilitySources'
        | 'worktreeVisibilitySourcePreferences'
        | 'projectGroupId'
        | 'projectGroupOrder'
        | 'projectHostSetupMethod'
      >
    > & {
      externalWorktreeVisibility?: Repo['externalWorktreeVisibility'] | null
      agentWorktreeVisibility?: Repo['agentWorktreeVisibility'] | null
      sourceControlAi?: Repo['sourceControlAi'] | null
      externalWorktreeDiscoverySuppressedAt?: Repo['externalWorktreeDiscoverySuppressedAt'] | null
    },
    hostId?: ExecutionHostId
  ): Repo | null {
    return this.getRepoUpdateOperations().updateRepo(id, updates, hostId)
  }

  private syncProjectHostSetupCompatibilityState(): void {
    const compatibilityState = mergeProjectHostSetupCompatibilityState(this.state, this.state.repos)
    this.state.projects = compatibilityState.projects
    this.state.projectHostSetups = compatibilityState.projectHostSetups
  }

  private projectHostSetupOperations: ProjectHostSetupPersistenceOperations | null = null

  private getProjectHostSetupOperations(): ProjectHostSetupPersistenceOperations {
    this.projectHostSetupOperations ??= new ProjectHostSetupPersistenceOperations({
      state: this.state,
      updateRepo: (id, updates, hostId) => this.updateRepo(id, updates, hostId),
      scheduleSave: () => this.scheduleSave()
    })
    return this.projectHostSetupOperations
  }

  private updateRepoBackedProjectHostSetup(
    setup: ProjectHostSetup,
    repo: Repo,
    updates: ProjectHostSetupUpdateArgs['updates']
  ): { setup: ProjectHostSetup; repo: Repo } | null {
    return this.getProjectHostSetupOperations().updateRepoBackedProjectHostSetup(
      setup,
      repo,
      updates
    )
  }

  private updateIndependentProjectHostSetup(
    setup: ProjectHostSetup,
    updates: ProjectHostSetupUpdateArgs['updates']
  ): ProjectHostSetup {
    return this.getProjectHostSetupOperations().updateIndependentProjectHostSetup(setup, updates)
  }

  private hydrateRepo(repo: Repo): Repo {
    return hydrateRepoOperation(repo, this.gitUsernameCache)
  }

  // ── Sparse Presets ─────────────────────────────────────────────────

  // ── Mobile client tab selections ──────────────────────────────────

  getMobileClientTabSelections(): PersistedMobileClientTabSelections {
    return this.state.mobileClientTabSelectionsByDeviceId ?? {}
  }

  setMobileClientTabSelections(next: PersistedMobileClientTabSelections): void {
    this.state.mobileClientTabSelectionsByDeviceId = next
    this.scheduleSave()
  }

  getSparsePresets(repoId: string): SparsePreset[] {
    return [...(this.state.sparsePresetsByRepo[repoId] ?? [])].sort((left, right) =>
      left.name.localeCompare(right.name)
    )
  }

  saveSparsePreset(preset: SparsePreset): SparsePreset {
    const existing = this.state.sparsePresetsByRepo[preset.repoId] ?? []
    const index = existing.findIndex((entry) => entry.id === preset.id)
    this.state.sparsePresetsByRepo[preset.repoId] =
      index === -1
        ? [...existing, preset]
        : existing.map((entry, i) => (i === index ? preset : entry))
    this.scheduleSave()
    return preset
  }

  removeSparsePreset(repoId: string, presetId: string): void {
    const existing = this.state.sparsePresetsByRepo[repoId] ?? []
    this.state.sparsePresetsByRepo[repoId] = existing.filter((entry) => entry.id !== presetId)
    this.scheduleSave()
  }

  // ── Automations ───────────────────────────────────────────────────

  private getAutomationDefinitionOperations(): AutomationDefinitionOperations {
    return {
      state: this.state,
      flush: () => this.flush(),
      recordCreated: () => this.recordFeatureInteraction('automation-created')
    }
  }

  private getAutomationRunOperations(): AutomationRunOperations {
    return {
      state: this.state,
      flush: () => this.flush(),
      recordManualRun: () => this.recordFeatureInteraction('automation-run'),
      getWorkspaceDisplayName: (workspaceId) =>
        this.getAutomationRunWorkspaceDisplayName(workspaceId)
    }
  }

  listAutomations(): Automation[] {
    return listAutomationsOperation(this.state)
  }

  listAutomationRuns(automationId?: string): AutomationRun[] {
    return listAutomationRunsOperation(this.state, automationId)
  }

  createAutomation(input: AutomationCreateInput): Automation {
    return createAutomationOperation(this.getAutomationDefinitionOperations(), input)
  }

  updateAutomation(id: string, updates: AutomationUpdateInput): Automation {
    return updateAutomationOperation(this.getAutomationDefinitionOperations(), id, updates)
  }

  deleteAutomation(id: string): void {
    deleteAutomationOperation(this.getAutomationDefinitionOperations(), id)
  }

  createAutomationRun(
    automation: Automation,
    scheduledFor: number,
    trigger: AutomationRunTrigger = 'scheduled'
  ): AutomationRun {
    return createAutomationRunOperation(
      this.getAutomationRunOperations(),
      automation,
      scheduledFor,
      trigger
    )
  }

  updateAutomationRun(result: AutomationDispatchResult): AutomationRun {
    return updateAutomationRunOperation(this.getAutomationRunOperations(), result)
  }

  snapshotAutomationRunWorkspaceDisplayName(workspaceId: string, displayName: string): number {
    return snapshotAutomationRunWorkspaceDisplayNameOperation(
      this.getAutomationRunOperations(),
      workspaceId,
      displayName
    )
  }

  private getAutomationRunWorkspaceDisplayName(
    workspaceId: string | null | undefined
  ): string | null {
    if (!workspaceId) {
      return null
    }
    return normalizeAutomationRunWorkspaceDisplayName(
      this.state.worktreeMeta[workspaceId]?.displayName ??
        getWorktreePathBasenameFromId(workspaceId)
    )
  }

  advanceAutomationNextRun(id: string, now = Date.now()): Automation {
    return advanceAutomationNextRunOperation(this.state, () => this.flush(), id, now)
  }

  getLatestAutomationOccurrence(automation: Automation, now = Date.now()): number | null {
    return getLatestAutomationOccurrenceOperation(automation, now)
  }

  // ── Worktree Meta ──────────────────────────────────────────────────

  getWorktreeMeta(worktreeId: string): WorktreeMeta | undefined {
    return this.state.worktreeMeta[worktreeId]
  }

  getAllWorktreeMeta(): Record<string, WorktreeMeta> {
    return this.state.worktreeMeta
  }

  setWorktreeMeta(worktreeId: string, meta: Partial<WorktreeMeta>): WorktreeMeta {
    const existing = this.state.worktreeMeta[worktreeId] || getDefaultWorktreeMeta()
    const updated = { ...existing, ...meta }
    updated.linkedWorkItem = normalizeWorkspaceLinkedItem(updated.linkedWorkItem)
    const linkedTaskSourceContext = normalizeStoredTaskSourceContext(
      updated.linkedTaskSourceContext
    )
    updated.linkedTaskSourceContext = isWorkspaceLinkedItemSourceContextMatch(
      updated.linkedWorkItem,
      linkedTaskSourceContext
    )
      ? linkedTaskSourceContext
      : null
    if (!updated.instanceId) {
      updated.instanceId = randomUUID()
    }
    this.state.worktreeMeta[worktreeId] = updated
    this.scheduleSave()
    return updated
  }

  removeWorktreeMeta(worktreeId: string, hostId?: ExecutionHostId | null): void {
    // A host-qualified removal names the owner; the persisted host is the fallback.
    const persistedOwner = this.state.worktreeMeta[worktreeId]?.hostId
    const owner = hostId ?? persistedOwner
    const preservesDifferentPersistedOwner = Boolean(
      hostId && persistedOwner && persistedOwner !== hostId
    )
    const ownerPartition = workspaceSessionOwnerPartitionForHost(owner)
    const preservesSameIdSessionOwner = Boolean(
      preservesDifferentPersistedOwner ||
      (owner &&
        hasWorktreeRemovalRepoOwnerOnOtherHost(
          this,
          getRepoIdFromWorktreeId(worktreeId),
          ownerPartition
        ))
    )
    // Skip partitions main never wrote: materializing one fences every sibling worktree of the repo.
    const partitions = new Set<ExecutionHostId>(
      workspaceSessionPartitionIdsForHost(owner).filter(
        (partition) =>
          this.hasPersistedWorkspaceSession(partition) &&
          // The local partition can be a remote spill surface or a same-id owner.
          // Preserve it whenever another owner may still use the bare id.
          (!preservesSameIdSessionOwner || partition === ownerPartition)
      )
    )
    // A repo-wide fence must not rebase a sibling's unpersisted tabs onto main's copy, and a spill
    // partition that never held this worktree has no claim on the repo at all.
    const fencedPartitions = new Set(
      [...partitions].filter(
        (partition) =>
          this.partitionOwnsWorktreeTabs(worktreeId, partition) ||
          (partition === ownerPartition &&
            !this.partitionHasOtherRepoWorktreeTabs(worktreeId, partition))
      )
    )
    if (!preservesDifferentPersistedOwner) {
      delete this.state.worktreeMeta[worktreeId]
      delete this.state.worktreeLineageById[worktreeId]
      delete this.state.workspaceLineageByChildKey[worktreeWorkspaceKey(worktreeId)]
    }
    for (const partition of partitions) {
      this.removeWorkspaceSessionOwnerInPartition(worktreeId, partition, {
        advanceTerminalTopologyRevision: fencedPartitions.has(partition)
      })
    }
    this.scheduleSave()
  }

  getWorktreeLineage(worktreeId: string): WorktreeLineage | undefined {
    return this.state.worktreeLineageById[worktreeId]
  }

  getAllWorktreeLineage(): Record<string, WorktreeLineage> {
    return this.state.worktreeLineageById
  }

  setWorktreeLineage(worktreeId: string, lineage: WorktreeLineage): WorktreeLineage {
    this.state.worktreeLineageById[worktreeId] = lineage
    this.scheduleSave()
    return lineage
  }

  removeWorktreeLineage(worktreeId: string): void {
    delete this.state.worktreeLineageById[worktreeId]
    this.scheduleSave()
  }

  /**
   * Re-key every worktreeId-keyed record from `oldWorktreeId` to `newWorktreeId` after the worktree folder (and its
   * `${repoId}::${path}` id) was renamed on disk, so a refresh re-binds state instead of orphaning it. Records the old id on
   * the new meta's `priorWorktreeIds` so session GC/hydration still recognizes PTY sessions minted under it. No-op when ids match.
   * Renderer counterpart: `buildWorktreeRenameState` in store/slices/worktrees.ts.
   */
  migrateWorktreeIdentity(oldWorktreeId: string, newWorktreeId: string): void {
    if (migrateWorktreeIdentityOperation(this.state, oldWorktreeId, newWorktreeId)) {
      this.scheduleSave()
    }
  }

  getWorkspaceLineage(childWorkspaceKey: WorkspaceKey): WorkspaceLineage | undefined {
    return this.state.workspaceLineageByChildKey[childWorkspaceKey]
  }

  getAllWorkspaceLineage(): Record<WorkspaceKey, WorkspaceLineage> {
    return this.state.workspaceLineageByChildKey
  }

  setWorkspaceLineage(lineage: WorkspaceLineage): WorkspaceLineage {
    this.state.workspaceLineageByChildKey[lineage.childWorkspaceKey] = lineage
    this.scheduleSave()
    return lineage
  }

  removeWorkspaceLineage(childWorkspaceKey: WorkspaceKey): void {
    delete this.state.workspaceLineageByChildKey[childWorkspaceKey]
    this.scheduleSave()
  }

  private removeWorkspaceLineageForFolderParent(folderWorkspaceId: string): void {
    const parentKey = folderWorkspaceKey(folderWorkspaceId)
    for (const [childKey, lineage] of Object.entries(this.state.workspaceLineageByChildKey)) {
      if (lineage.parentWorkspaceKey === parentKey) {
        delete this.state.workspaceLineageByChildKey[childKey as WorkspaceKey]
      }
    }
  }

  // ── Settings ───────────────────────────────────────────────────────

  getSettings(): GlobalSettings {
    return this.state.settings
  }

  onSettingsChanged(
    listener: (
      updates: Partial<GlobalSettings>,
      settings: GlobalSettings,
      originWebContentsId?: number
    ) => void
  ): () => void {
    this.settingsChangeListeners.add(listener)
    return () => {
      this.settingsChangeListeners.delete(listener)
    }
  }

  private notifySettingsChanged(
    updates: Partial<GlobalSettings>,
    originWebContentsId?: number
  ): void {
    for (const listener of this.settingsChangeListeners) {
      listener(updates, this.state.settings, originWebContentsId)
    }
  }

  // Why: renderer-visible UI state is written from desktop and mobile, so notify to keep bi-directional sync.
  onUIChanged(listener: (ui: PersistedState['ui']) => void): () => void {
    this.uiChangeListeners.add(listener)
    return () => {
      this.uiChangeListeners.delete(listener)
    }
  }

  private notifyUIChanged(): void {
    if (this.uiChangeListeners.size === 0) {
      return
    }
    const ui = this.getUI()
    for (const listener of this.uiChangeListeners) {
      listener(ui)
    }
  }

  private getSettingsMutationOperations(): SettingsMutationOperations {
    return {
      state: this.state,
      removeRetainedBlob: (slot) => this.protectedSecrets.removeRetainedBlob(slot),
      scheduleSave: () => this.scheduleSave(),
      notifySettingsChanged: (updates, originWebContentsId) =>
        this.notifySettingsChanged(updates, originWebContentsId)
    }
  }

  updateSettings(
    updates: Partial<GlobalSettings>,
    options: { notifyListeners?: boolean; originWebContentsId?: number } = {}
  ): GlobalSettings {
    return updateSettingsOperation(this.getSettingsMutationOperations(), updates, options)
  }

  // ── UI State ───────────────────────────────────────────────────────

  private getUIUpdateOperations(): UIUpdateOperations {
    return {
      state: this.state,
      removeRetainedBlob: (slot) => this.protectedSecrets.removeRetainedBlob(slot),
      setActiveView: (activeView) => this.activeViewPreference.set(activeView),
      getUI: () => this.getUI(),
      scheduleSave: () => this.scheduleSave(),
      notifyUIChanged: () => this.notifyUIChanged()
    }
  }

  getUI(): PersistedState['ui'] {
    return getPersistedUI(this.state, this.activeViewPreference.get())
  }

  updateUI(updates: Partial<PersistedState['ui']>): void {
    updatePersistedUI(this.getUIUpdateOperations(), updates)
  }

  private getFeatureInteractionOperations(): FeatureInteractionOperations {
    return {
      state: this.state,
      scheduleSave: () => this.scheduleSave(),
      notifyUIChanged: () => this.notifyUIChanged(),
      getUI: () => this.getUI()
    }
  }

  recordFeatureInteraction(id: FeatureInteractionId): PersistedState['ui'] {
    return recordFeatureInteractionOperation(this.getFeatureInteractionOperations(), id)
  }

  // ── Onboarding ────────────────────────────────────────────────────

  getOnboarding(): PersistedState['onboarding'] {
    const defaults = getDefaultOnboardingState()
    return {
      ...defaults,
      ...this.state.onboarding,
      checklist: {
        ...defaults.checklist,
        ...this.state.onboarding?.checklist
      }
    }
  }

  updateOnboarding(
    updates: Partial<Omit<PersistedState['onboarding'], 'checklist'>> & {
      checklist?: Partial<OnboardingChecklistState>
    }
  ): PersistedState['onboarding'] {
    const current = this.getOnboarding()
    this.state.onboarding = {
      ...current,
      ...updates,
      checklist: {
        ...current.checklist,
        ...updates.checklist
      }
    }
    this.scheduleSave()
    return this.getOnboarding()
  }

  // ── GitHub Cache ──────────────────────────────────────────────────

  getGitHubCache(): PersistedState['githubCache'] {
    return this.state.githubCache
  }

  setGitHubCache(cache: PersistedState['githubCache']): void {
    // Why no scheduleSave: cache is memory-only and snapshotted to a sidecar at flush; persisting here rewrote the whole state file every poll cycle.
    this.state.githubCache = cache
    this.githubCacheDirty = true
    this.githubCacheGeneration += 1
  }

  // ── Workspace Session ─────────────────────────────────────────────

  /** Resolve an execution host argument to a canonical id; unknown/empty falls back to 'local' for legacy callers. */
  private resolveHostId(hostId?: string | null): ExecutionHostId {
    return normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID
  }

  getWorkspaceSession(hostId?: string | null): PersistedState['workspaceSession'] {
    const resolved = this.resolveHostId(hostId)
    if (resolved === LOCAL_EXECUTION_HOST_ID) {
      return this.state.workspaceSession ?? getDefaultWorkspaceSession()
    }
    return this.state.workspaceSessionsByHostId?.[resolved] ?? getDefaultWorkspaceSession()
  }

  /** Whether a partition was ever written; `getWorkspaceSession` defaults absent ones and cannot tell them apart. */
  private hasPersistedWorkspaceSession(hostId: ExecutionHostId): boolean {
    return (
      hostId === LOCAL_EXECUTION_HOST_ID ||
      this.state.workspaceSessionsByHostId?.[hostId] !== undefined
    )
  }

  getWorkspaceSessionHostIds(): ExecutionHostId[] {
    const hostIds = new Set<ExecutionHostId>([LOCAL_EXECUTION_HOST_ID])
    for (const key of Object.keys(this.state.workspaceSessionsByHostId ?? {})) {
      const hostId = normalizeExecutionHostId(key)
      if (hostId) {
        hostIds.add(hostId)
      }
    }
    return [...hostIds]
  }

  readTerminalScrollbackSnapshot(ref: string): string | null {
    return readTerminalScrollbackSnapshotSync(ref, this.terminalScrollbackSnapshotStorage)
  }

  /** Resolve the worktree a terminal tab belongs to; more reliable than agent-echoed hook fields. */
  getWorktreeIdForTab(tabId: string): string | undefined {
    return findWorktreeIdForTab(this.getWorkspaceSession(), tabId)
  }

  setWorkspaceSession(session: PersistedState['workspaceSession'], hostId?: string | null): void {
    const resolved = this.resolveHostId(hostId)
    if (resolved === LOCAL_EXECUTION_HOST_ID) {
      this.setLocalWorkspaceSession(session)
      return
    }
    this.setHostWorkspaceSession(resolved, session)
  }

  removeWorkspaceSessionStateForWorktree(
    worktreeId: string,
    hostId?: ExecutionHostId | null,
    options: { advanceTerminalTopologyRevision?: boolean } = {}
  ): void {
    for (const resolved of workspaceSessionPartitionIdsForHost(hostId)) {
      this.removeWorkspaceSessionOwnerInPartition(worktreeId, resolved, options)
    }
  }

  private removeWorkspaceSessionOwnerInPartition(
    worktreeId: string,
    resolved: ExecutionHostId,
    options: { advanceTerminalTopologyRevision?: boolean }
  ): void {
    if (!this.hasPersistedWorkspaceSession(resolved)) {
      return
    }
    const current = this.getWorkspaceSession(resolved)
    const session = removeWorkspaceSessionOwner(current, worktreeId, {
      advanceTerminalTopologyRevision: options.advanceTerminalTopologyRevision ?? true
    })
    if (!session) {
      return
    }
    if (resolved === LOCAL_EXECUTION_HOST_ID) {
      this.state.workspaceSession = session
    } else {
      // Host scoping matters because identical repo/path ids may exist on two servers.
      this.state.workspaceSessionsByHostId = {
        ...this.state.workspaceSessionsByHostId,
        [resolved]: session
      }
    }
    this.scheduleSave()
  }

  /** Whether a partition still holds terminal membership for `worktreeId`. */
  private partitionOwnsWorktreeTabs(worktreeId: string, hostId: ExecutionHostId): boolean {
    return this.getWorkspaceSession(hostId).tabsByWorktree?.[worktreeId] !== undefined
  }

  /** Whether fencing this partition would rebase a sibling worktree of the same repo. */
  private partitionHasOtherRepoWorktreeTabs(worktreeId: string, hostId: ExecutionHostId): boolean {
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    const tabsByWorktree = this.getWorkspaceSession(hostId).tabsByWorktree ?? {}
    return Object.entries(tabsByWorktree).some(
      ([id, tabs]) =>
        id !== worktreeId && getRepoIdFromWorktreeId(id) === repoId && (tabs?.length ?? 0) > 0
    )
  }

  stageWorkspaceSessionBeforeUnload(
    session: PersistedState['workspaceSession'],
    hostId?: string | null
  ): void {
    const resolved = this.resolveHostId(hostId)
    if (resolved === LOCAL_EXECUTION_HOST_ID) {
      this.setLocalWorkspaceSession(session, true)
      return
    }
    this.setHostWorkspaceSession(resolved, session)
  }

  /** Persist a non-'local' host partition; remote hosts skip setLocalWorkspaceSession's local-daemon PTY-binding race guards. */
  private setHostWorkspaceSession(hostId: ExecutionHostId, session: WorkspaceSessionState): void {
    // Why: each partition owns its topology fence; renderer writes omit it and must rebase locally.
    session = sanitizeWorkspaceSessionTerminalRetirements(
      session,
      this.state.workspaceSessionsByHostId?.[hostId]
    )
    const pruned = pruneWorkspaceSessionBrowserHistory(
      pruneLocalTerminalScrollbackBuffers(session, this.state.repos)
    )
    this.state.workspaceSessionsByHostId = {
      ...this.state.workspaceSessionsByHostId,
      [hostId]: pruned
    }
    this.scheduleSave()
  }

  private setLocalWorkspaceSession(
    session: PersistedState['workspaceSession'],
    deferSnapshotFiles = false
  ): void {
    const prior = this.state.workspaceSession
    session = sanitizeWorkspaceSessionTerminalRetirements(session, prior)
    session = pruneWorkspaceSessionBrowserHistory(
      pruneLocalTerminalScrollbackBuffers(session, this.state.repos)
    )

    // Why (Issue #217): merge existing bindings when the incoming binding is empty, so a stale pre-spawn snapshot can't overwrite the durable PTY binding.
    const normalized = normalizeWorkspaceSessionPaneIdentities(
      session,
      prior?.terminalLayoutsByTabId
    )
    for (const entry of normalized.migrationUnsupportedEntries) {
      setMigrationUnsupportedPty(entry)
    }
    const remappedAcknowledgements = remapAcknowledgedAgentPaneKeys(
      this.state.ui?.acknowledgedAgentsByPaneKey,
      normalized.leafIdByInputLeafIdByTabId
    )
    if (remappedAcknowledgements.changed) {
      this.state.ui = {
        ...this.state.ui,
        acknowledgedAgentsByPaneKey: remappedAcknowledgements.acknowledgements
      }
    }
    for (const entry of normalized.legacyPaneKeyAliasEntries) {
      registerPersistedPaneKeyAlias(entry)
    }
    session = normalized.session
    const remapsByHostId = new Map<ExecutionHostId, WorkspaceSessionPaneIdentityRemap>([
      [LOCAL_EXECUTION_HOST_ID, normalized]
    ])
    const remappedLeases = remapSshRemotePtyLeaseLeafIds(
      this.state.sshRemotePtyLeases ?? [],
      remapsByHostId,
      new Set(this.getWorkspaceSessionHostIds())
    )
    if (remappedLeases.changed) {
      this.state.sshRemotePtyLeases = remappedLeases.leases
    }
    if (session && prior) {
      const priorTabs = prior.tabsByWorktree ?? {}
      const nextTabs = session.tabsByWorktree ?? {}
      const worktreeIdByTabId = new Map<string, string>()
      for (const [worktreeId, tabs] of Object.entries({ ...priorTabs, ...nextTabs })) {
        for (const tab of tabs) {
          worktreeIdByTabId.set(tab.id, worktreeId)
        }
      }
      for (const [worktreeId, tabs] of Object.entries(nextTabs)) {
        const priorList = priorTabs[worktreeId]
        if (!priorList) {
          continue
        }
        for (const tab of tabs) {
          if (tab.ptyId) {
            continue
          }
          const priorTab = priorList.find((t) => t.id === tab.id)
          if (
            priorTab?.ptyId &&
            this.isRestorablePtyBinding({
              ptyId: priorTab.ptyId,
              worktreeId,
              targetId: this.getConnectionIdForWorktree(worktreeId),
              tabId: tab.id
            })
          ) {
            tab.ptyId = priorTab.ptyId
          }
        }
      }
      const priorLayouts = prior.terminalLayoutsByTabId ?? {}
      const nextLayouts = session.terminalLayoutsByTabId ?? {}
      for (const [tabId, layout] of Object.entries(nextLayouts)) {
        const priorLayout = priorLayouts[tabId]
        if (!priorLayout?.ptyIdsByLeafId) {
          continue
        }
        const incoming = layout.ptyIdsByLeafId ?? {}
        const incomingHasAnyBinding = Object.keys(incoming).length > 0
        const liveLeafIds = this.getTerminalLayoutLeafIds(layout.root)
        const worktreeId = worktreeIdByTabId.get(tabId)
        const targetId = worktreeId ? this.getConnectionIdForWorktree(worktreeId) : null
        const restorableBindings = Object.fromEntries(
          Object.entries(priorLayout.ptyIdsByLeafId).filter(
            ([leafId, ptyId]) =>
              liveLeafIds.has(leafId) &&
              incoming[leafId] === undefined &&
              // Why: an empty layout map may be a stale pre-spawn snapshot; a partial map is intentional unless a durable SSH lease proves it.
              (incomingHasAnyBinding
                ? this.hasRestorableSshRemotePtyLease({
                    ptyId,
                    targetId,
                    worktreeId,
                    tabId,
                    leafId
                  })
                : this.isRestorablePtyBinding({ ptyId, targetId, worktreeId, tabId, leafId }))
          )
        )
        if (Object.keys(restorableBindings).length > 0) {
          layout.ptyIdsByLeafId = { ...restorableBindings, ...incoming }
          // Why: the same stale write that drops ptyIdsByLeafId may come from an older renderer lacking UUID-keyed metadata.
          const buffersByLeafId = preserveMissingLeafRecordEntries(
            priorLayout.buffersByLeafId,
            layout.buffersByLeafId,
            liveLeafIds
          )
          const scrollbackRefsByLeafId = preserveMissingLeafRecordEntries(
            priorLayout.scrollbackRefsByLeafId,
            layout.scrollbackRefsByLeafId,
            liveLeafIds
          )
          const titlesByLeafId = preserveMissingLeafRecordEntries(
            priorLayout.titlesByLeafId,
            layout.titlesByLeafId,
            liveLeafIds
          )
          if (buffersByLeafId) {
            layout.buffersByLeafId = buffersByLeafId
          }
          if (scrollbackRefsByLeafId) {
            layout.scrollbackRefsByLeafId = scrollbackRefsByLeafId
          }
          if (titlesByLeafId) {
            layout.titlesByLeafId = titlesByLeafId
          }
        }
      }
    }
    session = pruneLocalTerminalScrollbackBuffers(session, this.state.repos)
    if (!deferSnapshotFiles) {
      const migratedScrollback = migrateWorkspaceSessionTerminalScrollbackSnapshots(
        session,
        this.terminalScrollbackSnapshotStorage
      )
      session = migratedScrollback.session
      deleteRemovedTerminalScrollbackSnapshots(
        prior,
        session,
        this.terminalScrollbackSnapshotStorage
      )
    }
    this.state.workspaceSession = session
    if (deferSnapshotFiles) {
      this.enqueueTerminalScrollbackSnapshotWork(prior, session)
    }
    this.scheduleSave()
  }

  private enqueueTerminalScrollbackSnapshotWork(
    prior: WorkspaceSessionState | undefined,
    staged: WorkspaceSessionState
  ): void {
    const previous = this.pendingSnapshotFileWork ?? Promise.resolve()
    const work = previous
      .then(async () => {
        if (this.state.workspaceSession !== staged) {
          if (this.state.workspaceSession) {
            await deleteRemovedTerminalScrollbackSnapshotsAsync(
              prior,
              this.state.workspaceSession,
              this.terminalScrollbackSnapshotStorage
            )
          }
          return
        }
        const migrated = await migrateWorkspaceSessionTerminalScrollbackSnapshotsAsync(
          staged,
          this.terminalScrollbackSnapshotStorage
        )
        const current =
          this.state.workspaceSession === staged ? migrated : this.state.workspaceSession
        if (this.state.workspaceSession === staged) {
          this.state.workspaceSession = migrated
        } else if (current) {
          await deleteRemovedTerminalScrollbackSnapshotsAsync(
            migrated,
            current,
            this.terminalScrollbackSnapshotStorage
          )
        }
        if (current) {
          await deleteRemovedTerminalScrollbackSnapshotsAsync(
            prior,
            current,
            this.terminalScrollbackSnapshotStorage
          )
        }
      })
      .catch((error) => {
        console.error('[terminal-scrollback] Failed to prepare unload snapshots:', error)
      })
      .finally(() => {
        if (this.pendingSnapshotFileWork === work) {
          this.pendingSnapshotFileWork = null
        }
      })
    this.pendingSnapshotFileWork = work
  }

  patchWorkspaceSession(patch: WorkspaceSessionPatch, hostId?: string | null): void {
    const resolved = this.resolveHostId(hostId)
    // Why: the debounced hot path sends only changed slices; scalar/UI patches skip terminal normalization, topology patches keep stale-PTY protections.
    let next: WorkspaceSessionState = {
      ...this.getWorkspaceSession(resolved),
      ...patch
    }
    if (workspaceSessionPatchNeedsFullNormalization(patch)) {
      this.setWorkspaceSession(next, resolved)
      return
    }
    if (Object.hasOwn(patch, 'browserUrlHistory')) {
      next = pruneWorkspaceSessionBrowserHistory(next)
    }
    if (resolved === LOCAL_EXECUTION_HOST_ID) {
      this.state.workspaceSession = next
    } else {
      this.state.workspaceSessionsByHostId = {
        ...this.state.workspaceSessionsByHostId,
        [resolved]: next
      }
    }
    this.scheduleSave()
  }

  private getTerminalLayoutLeafIds(root: TerminalPaneLayoutNode | null): Set<string> {
    const leafIds = new Set<string>()
    const visit = (node: TerminalPaneLayoutNode | null): void => {
      if (!node) {
        return
      }
      if (node.type === 'leaf') {
        if (isTerminalLeafId(node.leafId)) {
          leafIds.add(node.leafId)
        }
        return
      }
      visit(node.first)
      visit(node.second)
    }
    visit(root)
    return leafIds
  }

  private isRestorablePtyBinding(binding: {
    ptyId: string
    targetId?: string | null
    worktreeId?: string
    tabId?: string
    leafId?: string
  }): boolean {
    const leases = this.state.sshRemotePtyLeases?.filter((entry) =>
      this.sshRemotePtyLeaseMatchesBinding(entry, binding)
    )
    return !leases?.some((lease) => lease.state === 'terminated' || lease.state === 'expired')
  }

  private getRelayPtyIdForSshLeaseComparison(targetId: string, ptyId: string): string {
    try {
      return toRelaySshPtyId(targetId, ptyId)
    } catch {
      return ptyId
    }
  }

  private getRelayPtyIdForSshLeaseStorage(targetId: string, ptyId: string): string {
    return toRelaySshPtyId(targetId, ptyId)
  }

  private sshRemotePtyLeaseMatchesBinding(
    lease: SshRemotePtyLease,
    binding: {
      ptyId: string
      targetId?: string | null
      worktreeId?: string
      tabId?: string
      leafId?: string
    }
  ): boolean {
    const bindingPtyId = this.getRelayPtyIdForSshLeaseComparison(lease.targetId, binding.ptyId)
    if (lease.ptyId !== bindingPtyId) {
      return false
    }
    // Why: remote PTY ids are scoped to a relay target; require stored lease context to match so missing fields don't tombstone unrelated panes.
    return (
      (binding.targetId === undefined ||
        binding.targetId === null ||
        lease.targetId === binding.targetId) &&
      (binding.worktreeId === undefined || lease.worktreeId === binding.worktreeId) &&
      (binding.tabId === undefined || lease.tabId === binding.tabId) &&
      (binding.leafId === undefined || lease.leafId === binding.leafId)
    )
  }

  private hasRestorableSshRemotePtyLease(binding: {
    ptyId: string
    targetId?: string | null
    worktreeId?: string
    tabId?: string
    leafId?: string
  }): boolean {
    return (
      this.state.sshRemotePtyLeases?.some(
        (lease) =>
          this.sshRemotePtyLeaseMatchesBinding(lease, binding) &&
          lease.state !== 'terminated' &&
          lease.state !== 'expired'
      ) ?? false
    )
  }

  private getConnectionIdForWorktree(worktreeId: string): string | null {
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    return this.state.repos.find((repo) => repo.id === repoId)?.connectionId ?? null
  }

  // Why: sync-flush the pty binding before pty:spawn returns to close the spawn/persist SIGKILL race (Issue #217).
  persistPtyBinding(
    args: {
      worktreeId: string
      tabId: string
      leafId: string
      ptyId: string
      incarnationId?: string
      startupCwd?: string
      expectedBinding?: { ptyId: string; incarnationId?: string }
      expectedSourceBinding?: PtyBindingSourceExpectation
      /** Set by host-initiated creates, which have no renderer session writer behind them. */
      hostAdmittedMembership?: boolean
    },
    hostId?: string | null
  ): boolean {
    const resolvedHostId = this.resolveHostId(hostId)
    const session = this.getWorkspaceSession(resolvedHostId)
    const paneKey = `${args.tabId}:${args.leafId}`
    const bindingWorktreeId = args.expectedSourceBinding?.worktreeId ?? args.worktreeId
    if (args.expectedSourceBinding) {
      const expected = args.expectedSourceBinding
      if (expected.tabId !== args.tabId) {
        return false
      }
      const sourceTab = session.tabsByWorktree?.[bindingWorktreeId]?.find(
        (candidate) => candidate.id === expected.tabId && candidate.worktreeId === bindingWorktreeId
      )
      const sourceLayout = session.terminalLayoutsByTabId?.[expected.tabId]
      const sourcePaneKey = `${expected.tabId}:${expected.leafId}`
      if (
        !sourceTab ||
        sourceLayout?.ptyIdsByLeafId?.[expected.leafId] !== expected.ptyId ||
        !layoutContainsLeafId(sourceLayout.root, expected.leafId) ||
        (expected.incarnationId !== undefined &&
          session.terminalPtyIncarnationsByPaneKey?.[sourcePaneKey] !== expected.incarnationId)
      ) {
        return false
      }
    }
    if (args.expectedBinding) {
      const tab = session.tabsByWorktree?.[bindingWorktreeId]?.find(
        (candidate) => candidate.id === args.tabId && candidate.worktreeId === bindingWorktreeId
      )
      const boundPtyId = session.terminalLayoutsByTabId?.[args.tabId]?.ptyIdsByLeafId?.[args.leafId]
      if (
        !tab ||
        boundPtyId !== args.expectedBinding.ptyId ||
        session.terminalPtyIncarnationsByPaneKey?.[paneKey] !== args.expectedBinding.incarnationId
      ) {
        return false
      }
    }
    if (resolvedHostId !== LOCAL_EXECUTION_HOST_ID) {
      this.state.workspaceSessionsByHostId = {
        ...this.state.workspaceSessionsByHostId,
        [resolvedHostId]: session
      }
    }
    const sessionBeforeBinding = cloneWorkspaceSessionState(session)
    const reconciledIncarnation =
      args.expectedBinding !== undefined &&
      args.incarnationId !== args.expectedBinding.incarnationId
    let terminalMembershipChanged = false
    let hostAdmittedTabCreated = false
    const advanceTopologyFence = (): void => {
      const repoId = getRepoIdFromWorktreeId(bindingWorktreeId)
      const currentRevision = session.terminalTopologyRevisionByRepoId?.[repoId] ?? 0
      // Why: a split, or a host-admitted tab the renderer has never seen, is itself
      // the authority — with no fence the renderer's pre-create tab list replays
      // over it and the tab is lost even on the repo's first such change.
      const establishesMembershipAuthority =
        args.expectedSourceBinding !== undefined || hostAdmittedTabCreated
      if (
        !reconciledIncarnation &&
        (!terminalMembershipChanged || (currentRevision <= 0 && !establishesMembershipAuthority))
      ) {
        return
      }
      // Why: host-admitted membership or incarnation changes must outrank a stale renderer replay.
      session.terminalTopologyRevisionByRepoId = {
        ...session.terminalTopologyRevisionByRepoId,
        [repoId]: currentRevision + 1
      }
    }
    const restoreSession = (): void => {
      if (resolvedHostId === LOCAL_EXECUTION_HOST_ID) {
        this.state.workspaceSession = sessionBeforeBinding
      } else {
        this.state.workspaceSessionsByHostId = {
          ...this.state.workspaceSessionsByHostId,
          [resolvedHostId]: sessionBeforeBinding
        }
      }
    }
    if (args.incarnationId) {
      session.terminalPtyIncarnationsByPaneKey = {
        ...session.terminalPtyIncarnationsByPaneKey,
        [paneKey]: args.incarnationId
      }
      if (session.terminalSurfaceTombstonesByPaneKey?.[paneKey]) {
        session.terminalSurfaceTombstonesByPaneKey = {
          ...session.terminalSurfaceTombstonesByPaneKey
        }
        delete session.terminalSurfaceTombstonesByPaneKey[paneKey]
      }
    }
    const tabs = session.tabsByWorktree?.[bindingWorktreeId]
    const tab = tabs?.find((t) => t.id === args.tabId)
    if (tab) {
      tab.ptyId = args.ptyId
    } else {
      terminalMembershipChanged = true
      hostAdmittedTabCreated = args.hostAdmittedMembership === true
      // Why: pty:spawn can beat the debounced writer; persist a minimal tab so hydration won't prune the binding as orphaned.
      const nextTabs = [
        ...(tabs ?? []),
        createMinimalPersistedTerminalTab({
          ...args,
          worktreeId: bindingWorktreeId,
          existingTabCount: tabs?.length ?? 0
        })
      ]
      session.tabsByWorktree = {
        ...session.tabsByWorktree,
        [bindingWorktreeId]: nextTabs
      }
      session.activeWorktreeId ??= bindingWorktreeId
      session.activeTabId ??= args.tabId
      session.activeTabIdByWorktree = {
        ...session.activeTabIdByWorktree,
        [bindingWorktreeId]: session.activeTabIdByWorktree?.[bindingWorktreeId] ?? args.tabId
      }
    }
    if (!isTerminalLeafId(args.leafId)) {
      // Why: keep legacy renderer-local pane ids out of durable leaf-keyed layout state after the UUID migration.
      advanceTopologyFence()
      try {
        this.flushOrThrow()
      } catch (err) {
        restoreSession()
        throw err
      }
      return true
    }
    const layout = session.terminalLayoutsByTabId?.[args.tabId]
    if (layout) {
      if (!layout.root) {
        terminalMembershipChanged = true
        // Why: createTab can persist an empty layout before TerminalPane mounts; the sync binding still needs a durable root.
        layout.root = { type: 'leaf', leafId: args.leafId }
        layout.activeLeafId = args.leafId
        layout.expandedLeafId = null
      } else if (!layoutContainsLeafId(layout.root, args.leafId)) {
        terminalMembershipChanged = true
        // Why: splitPane spawns before its snapshot reaches main; add a minimal leaf so a crash can't strand the pane's binding.
        layout.root = {
          type: 'split',
          direction: 'vertical',
          first: cloneLayoutNode(layout.root),
          second: { type: 'leaf', leafId: args.leafId }
        }
        layout.activeLeafId = args.leafId
        if (layout.expandedLeafId && !layoutContainsLeafId(layout.root, layout.expandedLeafId)) {
          layout.expandedLeafId = null
        }
      }
      layout.ptyIdsByLeafId = {
        ...layout.ptyIdsByLeafId,
        [args.leafId]: args.ptyId
      }
    } else {
      terminalMembershipChanged = true
      // Why: first tab spawn — persist a minimal layout so a SIGKILL before the renderer snapshot can't lose ptyIdsByLeafId.
      session.terminalLayoutsByTabId = {
        ...session.terminalLayoutsByTabId,
        [args.tabId]: {
          root: { type: 'leaf', leafId: args.leafId },
          activeLeafId: args.leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [args.leafId]: args.ptyId }
        }
      }
    }
    advanceTopologyFence()
    try {
      this.flushOrThrow()
    } catch (err) {
      restoreSession()
      throw err
    }
    return true
  }

  // ── SSH Targets ────────────────────────────────────────────────────

  private getSshTargetStateOperations(): SshTargetStateOperations {
    return {
      state: this.state,
      protectedSecrets: this.protectedSecrets,
      scheduleSave: () => this.scheduleSave(),
      flush: () => this.flush()
    }
  }

  getSshTargets(): SshTarget[] {
    return getSshTargetsOperation(this.state)
  }

  getSshTarget(id: string): SshTarget | undefined {
    return getSshTargetOperation(this.state, id)
  }

  addSshTarget(target: SshTarget): void {
    addSshTargetOperation(this.getSshTargetStateOperations(), target)
  }

  updateSshTarget(id: string, updates: Partial<Omit<SshTarget, 'id'>>): SshTarget | null {
    return updateSshTargetOperation(this.getSshTargetStateOperations(), id, updates)
  }

  removeSshTarget(id: string): void {
    removeSshTargetOperation(this.getSshTargetStateOperations(), id)
  }

  // ── Live Claude PTY sessions ───────────────────────────────────────

  getClaudeLivePtySessionIds(): string[] {
    return getClaudeLivePtySessionIdsOperation(this.state)
  }

  addClaudeLivePtySessionId(sessionId: string): void {
    addClaudeLivePtySessionIdOperation(this.getSshTargetStateOperations(), sessionId)
  }

  removeClaudeLivePtySessionId(sessionId: string): void {
    removeClaudeLivePtySessionIdOperation(this.getSshTargetStateOperations(), sessionId)
  }

  getRetiredWorktreeNameRegistry(repoId: string): RetiredNameRegistry {
    const stored = this.state.retiredWorktreeNamesByRepo?.[repoId]
    return stored
      ? { exhaustedTiers: stored.exhaustedTiers, names: [...stored.names] }
      : EMPTY_RETIRED_NAME_REGISTRY
  }

  getRetiredWorktreeNameRegistryForNamespace(namespaceKey: string): RetiredNameRegistry {
    const stored = this.state.retiredWorktreeNamesByNamespace?.[namespaceKey]
    return stored
      ? { exhaustedTiers: stored.exhaustedTiers, names: [...stored.names] }
      : EMPTY_RETIRED_NAME_REGISTRY
  }

  addRetiredWorktreeName(repoId: string, name: string): void {
    const normalized = normalizeRetirableGeneratedName(name)
    if (!repoId || !normalized) {
      return
    }
    this.applyRetiredWorktreeNames(repoId, [normalized])
  }

  mergeRetiredWorktreeNames(repoId: string, names: Iterable<string>): boolean {
    if (!repoId) {
      return false
    }
    const incoming = new Set<string>()
    for (const name of names) {
      const normalized = normalizeRetirableGeneratedName(name)
      if (normalized) {
        incoming.add(normalized)
      }
    }
    return incoming.size > 0 && this.applyRetiredWorktreeNames(repoId, incoming)
  }

  mergeRetiredWorktreeNamesForNamespace(namespaceKey: string, names: Iterable<string>): boolean {
    if (!namespaceKey) {
      return false
    }
    const normalized = new Set<string>()
    for (const name of names) {
      const candidate = normalizeRetirableGeneratedName(name)
      if (candidate) {
        normalized.add(candidate)
      }
    }
    const next = addRetiredNames(
      this.getRetiredWorktreeNameRegistryForNamespace(namespaceKey),
      normalized
    )
    if (!next) {
      return false
    }
    this.state.retiredWorktreeNamesByNamespace ??= {}
    recordRetirementNamespaceRegistry(
      this.state.retiredWorktreeNamesByNamespace,
      namespaceKey,
      next
    )
    this.scheduleSave()
    return true
  }

  private applyRetiredWorktreeNames(repoId: string, names: Iterable<string>): boolean {
    const next = addRetiredNames(this.getRetiredWorktreeNameRegistry(repoId), names)
    if (!next) {
      return false
    }
    this.state.retiredWorktreeNamesByRepo ??= {}
    this.state.retiredWorktreeNamesByRepo[repoId] = next
    this.scheduleSave()
    return true
  }

  getDeletedSshConfigAliases(): string[] {
    return getDeletedSshConfigAliasesOperation(this.state)
  }

  addDeletedSshConfigAlias(alias: string): void {
    addDeletedSshConfigAliasOperation(this.getSshTargetStateOperations(), alias)
  }

  removeDeletedSshConfigAlias(alias: string): void {
    removeDeletedSshConfigAliasOperation(this.getSshTargetStateOperations(), alias)
  }

  clearDeletedSshConfigAliases(): void {
    clearDeletedSshConfigAliasesOperation(this.getSshTargetStateOperations())
  }

  getRemovedSshTargetTombstones(): RemovedSshTargetTombstone[] {
    return getRemovedSshTargetTombstonesOperation(this.state)
  }

  addRemovedSshTargetTombstone(tombstone: RemovedSshTargetTombstone): void {
    addRemovedSshTargetTombstoneOperation(this.getSshTargetStateOperations(), tombstone)
  }

  removeRemovedSshTargetTombstone(oldTargetId: string): void {
    removeRemovedSshTargetTombstoneOperation(this.getSshTargetStateOperations(), oldTargetId)
  }

  /**
   * Re-point every repo and worktree meta pinned to a removed SSH target id onto
   * a re-added target's id so orphaned workspaces reattach. Returns re-pointed repo ids.
   */
  reassignSshTargetId(oldTargetId: string, newTargetId: string): string[] {
    const operations: SshTargetReassignmentOperations = {
      state: this.state,
      protectedSecrets: this.protectedSecrets,
      syncProjectHostSetupCompatibilityState: () => this.syncProjectHostSetupCompatibilityState(),
      scheduleSave: () => this.scheduleSave()
    }
    return reassignSshTargetIdOperation(operations, oldTargetId, newTargetId)
  }

  // ── SSH PTY Consumer Recovery ──────────────────────────────────────

  private getSshPtyConsumerRecoveryOperations(): SshPtyConsumerRecoveryOperations {
    return {
      state: this.state,
      protectedSecrets: this.protectedSecrets,
      flushDurableStateOrThrowAsync: () => this.flushDurableStateOrThrowAsync()
    }
  }

  getSshPtyConsumerRecovery(targetId: string): SshPtyConsumerRecovery | null {
    return getSshPtyConsumerRecoveryOperation(this.getSshPtyConsumerRecoveryOperations(), targetId)
  }

  async upsertSshPtyConsumerRecovery(record: SshPtyConsumerRecovery): Promise<void> {
    await upsertSshPtyConsumerRecoveryOperation(this.getSshPtyConsumerRecoveryOperations(), record)
  }

  async removeSshPtyConsumerRecovery(targetId: string): Promise<void> {
    await removeSshPtyConsumerRecoveryOperation(
      this.getSshPtyConsumerRecoveryOperations(),
      targetId
    )
  }

  // ── SSH Remote PTY Leases ──────────────────────────────────────────

  private getSshPtyBindingCleanupOperations(): SshPtyBindingCleanupOperations {
    return {
      state: this.state,
      toComparablePtyId: (targetId, ptyId) =>
        this.getRelayPtyIdForSshLeaseComparison(targetId, ptyId),
      scheduleSave: () => this.scheduleSave()
    }
  }

  private getSshPtyLeaseOperations(): SshPtyLeaseOperations {
    return {
      state: this.state,
      toStoredPtyId: (targetId, ptyId) => this.getRelayPtyIdForSshLeaseStorage(targetId, ptyId),
      clearBindingsForTarget: (targetId) =>
        clearSshRemotePtyBindingsForTargetOperation(
          this.getSshPtyBindingCleanupOperations(),
          targetId
        ),
      clearBindingsForLeases: (targetId, leases) =>
        clearSshRemotePtyBindingsForLeasesOperation(
          this.getSshPtyBindingCleanupOperations(),
          targetId,
          leases
        ),
      flush: () => this.flush(),
      flushDurableStateOrThrowAsync: () => this.flushDurableStateOrThrowAsync()
    }
  }

  getSshRemotePtyLeases(targetId?: string): SshRemotePtyLease[] {
    return getSshRemotePtyLeasesOperation(this.state, targetId)
  }

  upsertSshRemotePtyLease(
    lease: Omit<SshRemotePtyLease, 'createdAt' | 'updatedAt'> &
      Partial<Pick<SshRemotePtyLease, 'createdAt' | 'updatedAt'>>
  ): void {
    upsertSshRemotePtyLeaseOperation(this.getSshPtyLeaseOperations(), lease)
  }

  markSshRemotePtyLeases(targetId: string, state: SshRemotePtyLease['state']): void {
    markSshRemotePtyLeasesOperation(this.getSshPtyLeaseOperations(), targetId, state)
  }

  // Why no write of its own: the committed quit path calls this immediately before the final store
  // flush, and that flush is what persists it. A durable write here would race the flush and be
  // rejected the moment it latches, which is exactly how an attached lease used to survive quit.
  markSshRemotePtyLeasesForShutdown(targetId: string, state: SshRemotePtyLease['state']): void {
    markSshRemotePtyLeasesForShutdownOperation(this.getSshPtyLeaseOperations(), targetId, state)
  }

  async markSshRemotePtyLeasesAsync(
    targetId: string,
    state: SshRemotePtyLease['state']
  ): Promise<void> {
    await markSshRemotePtyLeasesAsyncOperation(this.getSshPtyLeaseOperations(), targetId, state)
  }

  async markSshRemotePtyLeasesAttachedAsync(
    targetId: string,
    ptyIds: readonly string[]
  ): Promise<void> {
    await markSshRemotePtyLeasesAttachedAsyncOperation(
      this.getSshPtyLeaseOperations(),
      targetId,
      ptyIds
    )
  }

  markSshRemotePtyLease(targetId: string, ptyId: string, state: SshRemotePtyLease['state']): void {
    markSshRemotePtyLeaseOperation(this.getSshPtyLeaseOperations(), targetId, ptyId, state)
  }

  removeSshRemotePtyLease(targetId: string, ptyId: string): void {
    removeSshRemotePtyLeaseOperation(this.getSshPtyLeaseOperations(), targetId, ptyId)
  }

  removeSshRemotePtyLeases(targetId: string): void {
    removeSshRemotePtyLeasesOperation(this.getSshPtyLeaseOperations(), targetId)
  }

  // ── Flush (for shutdown) ───────────────────────────────────────────

  flush(): void {
    if (this.quitFlushStarted) {
      return
    }
    try {
      this.flushOrThrow()
    } catch (err) {
      console.error('[persistence] Failed to flush state:', err)
    }
    try {
      this.flushActiveViewPreferenceOrThrow()
    } catch (err) {
      console.error('[active-view] Failed to flush preference:', err)
    }
    this.writeGithubCacheSnapshotSync()
  }

  /**
   * Async twin of flush() for the quit path.
   *
   * Why the quit path needs one: writeToDiskSync fsyncs a multi-MB file from the Electron
   * main thread. On a stalled network profile mount that syscall is uninterruptible, so the
   * app stops repainting and Force Quit stops working — and no main-thread deadline can
   * bound it, because the deadline's own timer is stuck behind the same block.
   *
   * Never throws — it joins the quit teardown barrier, where a rejection is noise.
   */
  flushAsync(): Promise<void> {
    if (this.quitFlushPromise) {
      return this.quitFlushPromise
    }
    this.quitFlushStarted = true
    this.quitFlushPromise = this.flushCurrentStateAsync(true).catch(() => {})
    return this.quitFlushPromise
  }

  flushPendingAsync(): Promise<void> {
    // Best-effort callers must not livelock while the live app keeps mutating state.
    return this.flushCurrentStateAsync(false, undefined, false).catch(() => {})
  }

  flushPendingOrThrowAsync(
    options: { signal?: AbortSignal; drainToStableGeneration?: boolean } = {}
  ): Promise<void> {
    if (this.writesFrozen || this.quitFlushStarted) {
      return Promise.reject(new Error('Cannot flush while persistence is finalized'))
    }
    return this.flushCurrentStateAsync(false, options.signal, options.drainToStableGeneration, true)
  }

  // Async twin of flushOrThrow: durable state only. Active-view and GitHub sidecars are
  // quit/startup work and must not be snapshotted on the live SSH establish/reconnect path.
  private async flushDurableStateOrThrowAsync(): Promise<void> {
    if (this.writesFrozen || this.quitFlushStarted) {
      throw new Error('Cannot flush while persistence is finalized')
    }
    for (;;) {
      if (this.writeTimer) {
        clearTimeout(this.writeTimer)
        this.writeTimer = null
      }
      this.firstPendingSaveAt = null
      const generation = this.writeGeneration
      await this.enqueueWrite()
      if (generation === this.writeGeneration) {
        break
      }
    }
  }

  private async flushCurrentStateAsync(
    final: boolean,
    signal?: AbortSignal,
    drainToStableGeneration = true,
    requireInitialGenerationDurable = false
  ): Promise<void> {
    const requiredDurableGeneration = requireInitialGenerationDurable ? this.writeGeneration : null
    for (;;) {
      if (signal?.aborted) {
        throw new Error('Persistence flush aborted')
      }
      if (this.writeTimer) {
        clearTimeout(this.writeTimer)
        this.writeTimer = null
      }
      this.firstPendingSaveAt = null
      const generation = this.writeGeneration
      try {
        await this.enqueueWrite()
      } catch (error) {
        await (final
          ? this.activeViewPreference.flushAsync()
          : this.activeViewPreference.flushPendingAsync(signal))
        await this.writeGithubCacheSnapshotAsync(final, signal)
        throw error
      }
      await (final
        ? this.activeViewPreference.flushAsync()
        : this.activeViewPreference.flushPendingAsync(signal))
      await this.writeGithubCacheSnapshotAsync(final, signal)
      if (signal?.aborted) {
        throw new Error('Persistence flush aborted')
      }
      if (!drainToStableGeneration) {
        if (
          requiredDurableGeneration === null ||
          this.lastDurableWriteGeneration >= requiredDurableGeneration
        ) {
          break
        }
        continue
      }
      if (generation === this.writeGeneration) {
        break
      }
    }
  }

  // Why best-effort: the sidecar is a refetchable cache; a failed write only costs a cold badge paint next launch, never data.
  private async writeGithubCacheSnapshotAsync(
    drainToStableGeneration = true,
    signal?: AbortSignal
  ): Promise<void> {
    if (!this.githubCacheDirty) {
      return
    }
    const previousWrite = this.pendingGithubCacheWrite ?? this.staleGithubCacheTempCleanup
    const nextWrite = previousWrite
      .then(async () => {
        while (this.githubCacheDirty) {
          if (signal?.aborted) {
            throw new Error('GitHub cache flush aborted')
          }
          const generation = this.githubCacheGeneration
          const cacheFile = getGithubCacheFile(this.dataFile)
          const tmpFile = durableWriteTempPath(cacheFile)
          let renamed = false
          try {
            await writeFile(tmpFile, JSON.stringify(this.state.githubCache), 'utf-8')
            if (generation === this.githubCacheGeneration) {
              await rename(tmpFile, cacheFile)
              renamed = true
              if (generation === this.githubCacheGeneration) {
                this.githubCacheDirty = false
              }
            }
          } finally {
            if (!renamed) {
              await rm(tmpFile).catch(() => {})
            }
          }
          if (signal?.aborted) {
            throw new Error('GitHub cache flush aborted')
          }
          if (!drainToStableGeneration) {
            break
          }
        }
      })
      .catch((err) => {
        console.warn('[persistence] Failed to write github cache snapshot:', err)
      })
      .finally(() => {
        if (this.pendingGithubCacheWrite === nextWrite) {
          this.pendingGithubCacheWrite = null
        }
      })
    this.pendingGithubCacheWrite = nextWrite
    await nextWrite
  }

  // Why: a project move rewrote the data file directly; in-memory state is now stale and any write would undo the transfer.
  freezeWrites(): void {
    this.writesFrozen = true
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
  }

  // Why best-effort: the sidecar is a refetchable cache; a failed write only costs a cold badge paint next launch, never data.
  private writeGithubCacheSnapshotSync(): void {
    if (!this.githubCacheDirty) {
      return
    }
    if (this.pendingGithubCacheWrite) {
      void this.writeGithubCacheSnapshotAsync()
      return
    }
    const cacheFile = getGithubCacheFile(this.dataFile)
    const generation = this.githubCacheGeneration
    const tmpFile = durableWriteTempPath(cacheFile)
    try {
      writeFileSync(tmpFile, JSON.stringify(this.state.githubCache), 'utf-8')
      renameSync(tmpFile, cacheFile)
      if (generation === this.githubCacheGeneration) {
        this.githubCacheDirty = false
      }
    } catch (err) {
      try {
        unlinkSync(tmpFile)
      } catch {
        // Best-effort cleanup.
      }
      console.warn('[persistence] Failed to write github cache snapshot:', err)
    }
  }
}

function getDefaultWorktreeMeta(): WorktreeMeta {
  return {
    instanceId: randomUUID(),
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    linkedBitbucketPR: null,
    linkedAzureDevOpsPR: null,
    linkedGiteaPR: null,
    linkedWorkItem: null,
    linkedTaskSourceContext: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: Date.now(),
    lastActivityAt: 0,
    workspaceStatus: DEFAULT_WORKSPACE_STATUS_ID
  }
}
