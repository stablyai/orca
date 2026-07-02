/* eslint-disable max-lines -- Why: persistence keeps schema defaults, migration,
load/save, and flush logic in one file so the full storage contract is reviewable
as a unit instead of being scattered across modules. */
import { app, safeStorage } from 'electron'
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  unlinkSync,
  copyFileSync,
  statSync,
  realpathSync
} from 'node:fs'
import { writeFile, rename, mkdir, rm, copyFile } from 'node:fs/promises'
import { join, dirname, isAbsolute, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import type {
  Automation,
  AutomationCreateInput,
  AutomationDispatchResult,
  AutomationPrecheckResult,
  AutomationRunOutputSnapshot,
  AutomationRun,
  AutomationSchedulerOwner,
  AutomationRunTrigger,
  AutomationUpdateInput
} from '../shared/automations-types'
import {
  latestAutomationOccurrenceAtOrBefore,
  nextAutomationOccurrenceAfter
} from '../shared/automation-schedules'
import { getAutomationLegacyRepoId } from '../shared/automation-run-identity'
import { normalizeAutomationPrecheck } from '../shared/automation-precheck'
import type {
  PersistedState,
  Project,
  ProjectUpdateArgs,
  ProjectHostSetup,
  ProjectHostSetupCreateArgs,
  ProjectHostSetupCreateResult,
  ProjectHostSetupDeleteArgs,
  ProjectHostSetupDeleteResult,
  ProjectHostSetupUpdateArgs,
  ProjectHostSetupUpdateResult,
  RepoProjectHostSetupMethod,
  Repo,
  ProjectGroup,
  FolderWorkspace,
  SparsePreset,
  WorktreeMeta,
  WorktreeLineage,
  WorkspaceLineage,
  WorkspaceKey,
  GlobalSettings,
  OrcaWorkspaceLayout,
  NotificationSettings,
  OnboardingChecklistState,
  OnboardingOutcome,
  OnboardingState,
  LegacyPaneKeyAliasEntry,
  TerminalPaneLayoutNode,
  TerminalLayoutSnapshot,
  TerminalTab,
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../shared/types'
import {
  deriveGlobalWindowsRuntimeDefaultFromLegacySettings,
  normalizeProjectRuntimePreference
} from '../shared/project-execution-runtime'
import { projectHostSetupProjectionFromRepos } from '../shared/project-host-setup-projection'
import type { GitRemoteIdentity } from '../shared/git-remote-identity'
import {
  buildTaskSourceContextFromRepo,
  buildWorkspaceRunContext
} from '../shared/task-source-context'
import type { MigrationUnsupportedPtyEntry } from '../shared/agent-status-types'
import { MOBILE_PAIRING_USERDATA_FILES } from './runtime/mobile-pairing-files'
import { hardenExistingSecureFile } from '../shared/secure-file'
import {
  LEGACY_DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS,
  type SshRemotePtyLease,
  type SshTarget
} from '../shared/ssh-types'
import { isFolderRepo } from '../shared/repo-kind'
import { getGitUsername } from './git/repo'
import { getRepoExecutionHostId, parseExecutionHostId } from '../shared/execution-host'
import {
  getDefaultPersistedState,
  getDefaultNotificationSettings,
  getDefaultOnboardingState,
  getDefaultVoiceSettings,
  getDefaultUIState,
  getDefaultRepoHookSettings,
  getDefaultWorkspaceSession,
  getWorktreeCardModeProperties,
  isDefaultedCompactWorktreeCardProperties,
  normalizeAgentActivityDisplayMode,
  normalizeWorktreeCardProperties,
  ONBOARDING_FLOW_VERSION,
  ONBOARDING_FINAL_STEP
} from '../shared/constants'
import { parseWorkspaceSession } from '../shared/workspace-session-schema'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostOrder,
  normalizeExecutionHostId,
  normalizeVisibleExecutionHostIds,
  type ExecutionHostId
} from '../shared/execution-host'
import { toRelaySshPtyId } from './providers/ssh-pty-id'
import {
  isTerminalLeafId,
  makePaneKey,
  parseLegacyNumericPaneKey,
  parsePaneKey
} from '../shared/stable-pane-id'
import {
  setMigrationUnsupportedPty,
  setMigrationUnsupportedPtyPersistenceListener
} from './agent-hooks/migration-unsupported-pty-state'
import { agentHookServer } from './agent-hooks/server'
import { pruneLocalTerminalScrollbackBuffers } from '../shared/workspace-session-terminal-buffers'
import { pruneWorkspaceSessionBrowserHistory } from '../shared/workspace-session-browser-history'
import { getRepoIdFromWorktreeId, getWorktreePathBasenameFromId } from '../shared/worktree-id'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../shared/cross-platform-path'
import { normalizeTerminalQuickCommands } from '../shared/terminal-quick-commands'
import { normalizeTaskProviderSettings } from '../shared/task-providers'
import { normalizeAutoRenameBranchFromWorkDefaultOn } from '../shared/auto-rename-branch-from-work-settings'
import { normalizeOpenInApplications } from '../shared/open-in-applications'
import { normalizeTerminalShortcutPolicy } from '../shared/keybindings'
import { normalizeSourceControlGroupOrder } from '../shared/source-control-group-order'
import { normalizeAppIconId } from '../shared/app-icon'
import { normalizeTerminalCustomThemes } from '../shared/terminal-custom-themes'
import {
  legacyTerminalScrollbackBytesToRows,
  normalizeDesktopTerminalScrollbackRows
} from '../shared/terminal-scrollback-policy'
import {
  compareFeatureInteractionUsageBuckets,
  getFeatureInteractionCategory,
  getFeatureInteractionUsageBucket,
  normalizeFeatureInteractions,
  normalizeFeatureInteractionTelemetryBuckets,
  type FeatureInteractionId
} from '../shared/feature-interactions'
import { normalizeContextualTourIds } from '../shared/contextual-tours'
import { normalizeFeatureTipIds } from '../shared/feature-tips'
import {
  DEFAULT_WORKSPACE_STATUS_ID,
  clampWorkspaceBoardColumnWidth,
  clampWorkspaceBoardOpacity,
  normalizePersistedWorkspaceStatuses,
  normalizeWorkspaceStatuses
} from '../shared/workspace-statuses'
import { clampMarkdownTocPanelWidth } from '../shared/markdown-toc-panel-width'
import { isLegacyRepoForExternalWorktreeVisibility } from '../shared/worktree-ownership'
import { sanitizeRepoIcon } from '../shared/repo-icon'
import { normalizeRepoBadgeColor } from '../shared/repo-badge-color'
import {
  clearMissingProjectGroupMemberships,
  createProjectGroup,
  getNextProjectGroupOrder,
  getProjectGroupSubtreeIds,
  normalizeProjectGroupName,
  normalizeProjectGroups
} from '../shared/project-groups'
import { createNestedProjectGroupResolver } from './project-groups/nested-repo-import'
import {
  mergeLegacyCommitMessageAiIntoSourceControlAi,
  normalizeRepoSourceControlAiOverrides,
  normalizeSourceControlAiSettings,
  projectSourceControlAiToLegacyCommitMessageAi,
  sourceControlAiSettingsFromLegacy
} from '../shared/source-control-ai'
import {
  DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES,
  SOURCE_CONTROL_TEXT_ACTION_IDS
} from '../shared/source-control-ai-actions'
import { normalizeDisabledTuiAgents } from '../shared/tui-agent-selection'
import {
  DEFAULT_TUI_AGENT_ARGS,
  DEFAULT_TUI_AGENT_ENV,
  hasUnsupportedTuiAgentArgs,
  normalizeTuiAgentArgsRecord,
  normalizeTuiAgentEnvRecord
} from '../shared/tui-agent-launch-defaults'
import { normalizeTerminalCursorStyleDefault } from '../shared/terminal-cursor-style-settings'
import { normalizeUiLanguage } from '../shared/ui-language'
import { normalizeBrowserPageZoomLevel } from '../shared/browser-page-zoom'
import { persistedUIValuesEqual } from '../shared/persisted-ui-equality'
import {
  normalizeFolderWorkspaceName,
  normalizeFolderWorkspaces
} from '../shared/folder-workspaces'
import {
  folderWorkspaceKey,
  isWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../shared/workspace-scope'
import {
  collectTerminalScrollbackSnapshotRefs,
  deleteTerminalScrollbackSnapshotSync,
  migrateWorkspaceSessionTerminalScrollbackSnapshots,
  readTerminalScrollbackSnapshotSync
} from './terminal-scrollback-snapshots'
import { track } from './telemetry/client'
import { getCohortAtEmit } from './telemetry/cohort-classifier'
import { isStartupDiagnosticsEnabled, logStartupDiagnostic } from './startup/startup-diagnostics'

function encrypt(plaintext: string): string {
  if (!plaintext || !safeStorage.isEncryptionAvailable()) {
    return plaintext
  }
  try {
    return safeStorage.encryptString(plaintext).toString('base64')
  } catch (err) {
    console.error('[persistence] Encryption failed:', err)
    return plaintext
  }
}

function decrypt(ciphertext: string): string {
  if (!ciphertext || !safeStorage.isEncryptionAvailable()) {
    return ciphertext
  }
  try {
    return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'))
  } catch {
    // Why: if decryption fails, it likely means the value was stored as
    // plaintext (pre-encryption build) or the OS keychain changed. Fall
    // back to the raw string so users don't lose their cookie after upgrade.
    console.warn(
      '[persistence] safeStorage decryption failed — returning ciphertext as-is. Possible keychain reset.'
    )
    return ciphertext
  }
}

function encryptOptionalSecret(value: string | null | undefined): string | null {
  return value ? encrypt(value) : null
}

function decryptOptionalSecret(value: string | null | undefined): string | null {
  return value ? decrypt(value) : null
}

function retireLegacyInstructionsForClearedTextActionRecipes(
  sourceControlAi: GlobalSettings['sourceControlAi'],
  previousSettings: GlobalSettings
): GlobalSettings['sourceControlAi'] {
  if (!sourceControlAi?.actions) {
    return sourceControlAi
  }

  const previousSourceControlAi = normalizeSourceControlAiSettings(
    previousSettings.sourceControlAi,
    previousSettings.commitMessageAi
  )
  let instructionsByOperation = sourceControlAi.instructionsByOperation
  let changed = false
  for (const actionId of SOURCE_CONTROL_TEXT_ACTION_IDS) {
    if (
      sourceControlAi.actions[actionId]?.commandInputTemplate !==
      DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES[actionId]
    ) {
      continue
    }
    if (
      previousSourceControlAi.actions?.[actionId]?.commandInputTemplate ===
        DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES[actionId] ||
      instructionsByOperation?.[actionId] !==
        previousSourceControlAi.instructionsByOperation[actionId]
    ) {
      continue
    }
    if (instructionsByOperation?.[actionId] === '') {
      continue
    }
    // Why: `{basePrompt}` is the explicit clear state; an empty instruction
    // shadows rollback `commitMessageAi.customPrompt` during normalize/project.
    instructionsByOperation = { ...instructionsByOperation, [actionId]: '' }
    changed = true
  }

  return changed ? { ...sourceControlAi, instructionsByOperation } : sourceControlAi
}

// Why: the data-file path must not be a module-level constant. Module-level
// code runs at import time — before configureDevUserDataPath() redirects the
// userData path in index.ts — so a constant would capture the default (non-dev)
// path, causing dev and production instances to share the same file and silently
// overwrite each other.
//
// It also must not be resolved lazily on every call, because app.setName('Orca')
// runs before the Store constructor and would change the resolved path from
// lowercase 'orca' to uppercase 'Orca'. On case-sensitive filesystems (Linux)
// this would look in the wrong directory and lose existing user data.
//
// Solution: index.ts calls initDataPath() right after configureDevUserDataPath()
// but before app.setName(), capturing the correct path at the right moment.
let _dataFile: string | null = null
let _userDataDir: string | null = null

export function initDataPath(): void {
  const userDataDir = app.getPath('userData')
  _userDataDir = userDataDir
  _dataFile = join(userDataDir, 'orca-data.json')
}

function getDataFile(): string {
  if (!_dataFile) {
    // Safety fallback — should not be hit in normal startup.
    const userDataDir = app.getPath('userData')
    _userDataDir = userDataDir
    _dataFile = join(userDataDir, 'orca-data.json')
  }
  return _dataFile
}

/**
 * Return the userData directory captured at initDataPath() time, before
 * app.setName() can change how app.getPath('userData') resolves.
 *
 * Subsystems that must share storage with orca-data.json (mobile pairing's
 * DeviceRegistry, E2EE keypair, runtime metadata) read this instead of
 * resolving the path late, which on case-sensitive filesystems can land in a
 * different directory and lose paired devices across restarts/updates.
 */
export function getCanonicalUserDataPath(): string {
  if (!_userDataDir) {
    // Safety fallback — should not be hit in normal startup.
    _userDataDir = app.getPath('userData')
  }
  return _userDataDir
}

/**
 * Copy legacy mobile pairing credentials into the canonical userData directory.
 *
 * Existing installs may already have credentials in the late app.getPath('userData')
 * directory. Before switching the runtime server to the canonical path, copy the
 * registry and E2EE keypair forward as a pair so an update does not force one
 * last re-pair or mix devices with the wrong key.
 */
export function migrateMobilePairingDataToCanonicalUserDataPath(sourceUserDataDir: string): void {
  const targetUserDataDir = getCanonicalUserDataPath()
  if (resolve(sourceUserDataDir) === resolve(targetUserDataDir)) {
    return
  }

  const migrations = MOBILE_PAIRING_USERDATA_FILES.map((fileName) => ({
    sourcePath: join(sourceUserDataDir, fileName),
    targetPath: join(targetUserDataDir, fileName)
  }))
  if (migrations.some(({ sourcePath }) => !existsSync(sourcePath))) {
    return
  }
  if (migrations.some(({ targetPath }) => existsSync(targetPath))) {
    return
  }

  mkdirSync(targetUserDataDir, { recursive: true })
  for (const { sourcePath, targetPath } of migrations) {
    copyFileSync(sourcePath, targetPath)
    // Why: these are credential files (device tokens, E2EE secret key). copyFileSync
    // does not carry Windows ACLs, so re-assert the current-user-only restriction on
    // the copy instead of relying on the runtime's later lazy re-harden on read.
    hardenExistingSecureFile(targetPath)
  }
}

// Why (issue #1158): keep 5 rolling backups of orca-data.json so a corrupt or
// empty write leaves at least one earlier copy recoverable. Five snapshots at
// >=1-hour spacing cover recent work without churning disk on every debounce.
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

/** Normalize the persisted non-'local' host partitions. 'local' is intentionally
 *  dropped here — it is the legacy workspaceSession blob — so the two surfaces
 *  never diverge. Each partition is zod-validated independently: a corrupt host
 *  drops to defaults without taking out the others. Idempotent: re-running on an
 *  already-normalized map yields the same shape. */
function parseWorkspaceSessionsByHostId(
  raw: unknown,
  defaults: WorkspaceSessionState
): Partial<Record<ExecutionHostId, WorkspaceSessionState>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {}
  }
  const partitions: Partial<Record<ExecutionHostId, WorkspaceSessionState>> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const hostId = normalizeExecutionHostId(key)
    // Why: 'local' belongs in workspaceSession; an invalid/local key here is
    // legacy noise and must not shadow the canonical local partition.
    if (!hostId || hostId === LOCAL_EXECUTION_HOST_ID) {
      continue
    }
    const result = parseWorkspaceSession(value)
    if (!result.ok) {
      console.error(
        `[persistence] Corrupt workspace session for host ${hostId}, using defaults:`,
        result.error
      )
      continue
    }
    partitions[hostId] = { ...defaults, ...result.value }
  }
  return partitions
}

function backupPath(dataFile: string, index: number): string {
  return `${dataFile}.bak.${index}`
}

function buildWorkspaceDirHistoryForUpdate(
  current: GlobalSettings,
  updates: Partial<GlobalSettings>
): OrcaWorkspaceLayout[] | null {
  if (!('workspaceDir' in updates) && !('nestWorkspaces' in updates)) {
    return null
  }
  const nextPath = updates.workspaceDir ?? current.workspaceDir
  const nextNestWorkspaces = updates.nestWorkspaces ?? current.nestWorkspaces
  if (
    normalizeRuntimePathForComparison(nextPath) ===
      normalizeRuntimePathForComparison(current.workspaceDir) &&
    nextNestWorkspaces === current.nestWorkspaces
  ) {
    return null
  }

  const previousLayout = {
    path: current.workspaceDir,
    nestWorkspaces: current.nestWorkspaces
  }
  const existing = current.workspaceDirHistory ?? []
  const next = [...existing]
  const previousKey = getWorkspaceLayoutHistoryKey(previousLayout)
  if (!next.some((layout) => getWorkspaceLayoutHistoryKey(layout) === previousKey)) {
    next.push(previousLayout)
  }
  return next
}

type LegacyTerminalScrollbackSettings = {
  terminalScrollbackRows?: unknown
  terminalScrollbackBytes?: unknown
}

const LEGACY_TERMINAL_TUI_SCROLL_SENSITIVITY_DEFAULT = 3

function readLegacyTerminalScrollbackSettings(settings: unknown): LegacyTerminalScrollbackSettings {
  return settings && typeof settings === 'object'
    ? (settings as LegacyTerminalScrollbackSettings)
    : {}
}

function stripLegacyTerminalScrollbackBytes(
  settings: Partial<GlobalSettings> | undefined
): Partial<GlobalSettings> {
  const { terminalScrollbackBytes: _legacyScrollbackBytes, ...rest } = (settings ??
    {}) as Partial<GlobalSettings> & { terminalScrollbackBytes?: unknown }
  void _legacyScrollbackBytes
  return rest
}

function migrateTerminalScrollbackRows(settings: unknown): {
  rows: number
  needsSave: boolean
} {
  const legacySettings = readLegacyTerminalScrollbackSettings(settings)
  const hasRows = Object.prototype.hasOwnProperty.call(legacySettings, 'terminalScrollbackRows')
  const hasLegacyBytes = Object.prototype.hasOwnProperty.call(
    legacySettings,
    'terminalScrollbackBytes'
  )
  const rows = hasRows
    ? normalizeDesktopTerminalScrollbackRows(legacySettings.terminalScrollbackRows)
    : legacyTerminalScrollbackBytesToRows(legacySettings.terminalScrollbackBytes)

  return {
    rows,
    needsSave: !hasRows || hasLegacyBytes || legacySettings.terminalScrollbackRows !== rows
  }
}

function migrateTerminalTuiScrollSensitivityDefault(settings: GlobalSettings | undefined): {
  settings: Pick<
    GlobalSettings,
    'terminalTuiScrollSensitivity' | 'terminalTuiScrollSensitivityDefaultedToOne'
  >
  needsSave: boolean
} {
  const alreadyDefaultedToOne = settings?.terminalTuiScrollSensitivityDefaultedToOne === true
  const current = settings?.terminalTuiScrollSensitivity
  const shouldMoveInheritedDefault =
    !alreadyDefaultedToOne &&
    (current === undefined || current === LEGACY_TERMINAL_TUI_SCROLL_SENSITIVITY_DEFAULT)
  const terminalTuiScrollSensitivity = shouldMoveInheritedDefault ? 1 : (current ?? 1)

  return {
    settings: {
      terminalTuiScrollSensitivity,
      terminalTuiScrollSensitivityDefaultedToOne: true
    },
    needsSave: !alreadyDefaultedToOne || current === undefined
  }
}

function getWorkspaceLayoutHistoryKey(layout: OrcaWorkspaceLayout): string {
  return `${normalizeRuntimePathForComparison(layout.path)}:${layout.nestWorkspaces}`
}

function migrateAgentYoloDefaults(
  settings: GlobalSettings | undefined
): Pick<GlobalSettings, 'agentDefaultArgs' | 'agentDefaultEnv' | 'agentYoloDefaultsMigrated'> {
  const existingArgs = normalizeTuiAgentArgsRecord(settings?.agentDefaultArgs)
  const existingEnv = normalizeTuiAgentEnvRecord(settings?.agentDefaultEnv)
  if (settings?.agentYoloDefaultsMigrated === true) {
    return {
      agentDefaultArgs: existingArgs,
      agentDefaultEnv: existingEnv,
      agentYoloDefaultsMigrated: true
    }
  }

  const commandOverrides = settings?.agentCmdOverrides ?? {}
  const migratedArgs = { ...existingArgs }
  for (const [agent, args] of Object.entries(DEFAULT_TUI_AGENT_ARGS)) {
    if (agent in migratedArgs) {
      continue
    }
    if (agent in commandOverrides) {
      migratedArgs[agent as keyof typeof DEFAULT_TUI_AGENT_ARGS] = ''
      continue
    }
    migratedArgs[agent as keyof typeof DEFAULT_TUI_AGENT_ARGS] = args
  }

  const migratedEnv = { ...existingEnv }
  for (const [agent, env] of Object.entries(DEFAULT_TUI_AGENT_ENV)) {
    if (agent in migratedEnv) {
      continue
    }
    if (agent in commandOverrides) {
      migratedEnv[agent as keyof typeof DEFAULT_TUI_AGENT_ENV] = {}
      continue
    }
    migratedEnv[agent as keyof typeof DEFAULT_TUI_AGENT_ENV] = { ...env }
  }

  return {
    // Why: legacy users could only customize per-agent launch defaults via
    // command overrides, so those agents are treated as already user-owned.
    agentDefaultArgs: migratedArgs,
    agentDefaultEnv: migratedEnv,
    agentYoloDefaultsMigrated: true
  }
}

function normalizeGroupBy(groupBy: unknown): PersistedState['ui']['groupBy'] {
  if (
    groupBy === 'none' ||
    groupBy === 'workspace-status' ||
    groupBy === 'repo' ||
    groupBy === 'pr-status'
  ) {
    return groupBy
  }
  if (groupBy === 'flat') {
    return 'none'
  }
  return getDefaultUIState().groupBy
}

function normalizeShowDotfilesByWorktree(value: unknown): Record<string, boolean> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const out: Record<string, boolean> = {}
  for (const [worktreeId, showDotfiles] of Object.entries(value as Record<string, unknown>)) {
    if (
      !worktreeId ||
      worktreeId === '__proto__' ||
      worktreeId === 'constructor' ||
      worktreeId === 'prototype' ||
      typeof showDotfiles !== 'boolean'
    ) {
      continue
    }
    out[worktreeId] = showDotfiles
  }
  return out
}

function mergeFeatureInteractions(
  current: PersistedState['ui']['featureInteractions'],
  incoming: PersistedState['ui']['featureInteractions']
): PersistedState['ui']['featureInteractions'] {
  const currentNormalized = normalizeFeatureInteractions(current)
  const incomingNormalized = normalizeFeatureInteractions(incoming)
  const merged = { ...currentNormalized }
  for (const [id, incomingRecord] of Object.entries(incomingNormalized)) {
    const currentRecord = currentNormalized[id as keyof typeof currentNormalized]
    merged[id as keyof typeof merged] = currentRecord
      ? {
          firstInteractedAt: Math.min(
            currentRecord.firstInteractedAt,
            incomingRecord.firstInteractedAt
          ),
          interactionCount: Math.max(
            currentRecord.interactionCount,
            incomingRecord.interactionCount
          )
        }
      : incomingRecord
  }
  return merged
}

function mergeContextualTourSeenIds(
  current: PersistedState['ui']['contextualToursSeenIds'],
  incoming: PersistedState['ui']['contextualToursSeenIds']
): PersistedState['ui']['contextualToursSeenIds'] {
  const merged = new Set(normalizeContextualTourIds(current))
  for (const id of normalizeContextualTourIds(incoming)) {
    merged.add(id)
  }
  return [...merged]
}

function stripMainOwnedTelemetryMarkerFromUI(
  value: Partial<PersistedState['ui']> | undefined
): Partial<PersistedState['ui']> {
  if (!value || typeof value !== 'object') {
    return {}
  }
  const { featureInteractionTelemetryBuckets: _reserved, ...ui } = value as Partial<
    PersistedState['ui']
  > & {
    featureInteractionTelemetryBuckets?: unknown
  }
  void _reserved
  return ui
}

function normalizeSortBy(sortBy: unknown): PersistedState['ui']['sortBy'] {
  if (
    sortBy === 'smart' ||
    sortBy === 'recent' ||
    sortBy === 'repo' ||
    sortBy === 'name' ||
    sortBy === 'manual'
  ) {
    return sortBy
  }
  return getDefaultUIState().sortBy
}

function normalizeProjectOrderBy(projectOrderBy: unknown): PersistedState['ui']['projectOrderBy'] {
  if (projectOrderBy === 'manual' || projectOrderBy === 'recent') {
    return projectOrderBy
  }
  return getDefaultUIState().projectOrderBy
}

function normalizeRightSidebarTab(tab: unknown): PersistedState['ui']['rightSidebarTab'] {
  if (
    tab === 'explorer' ||
    tab === 'search' ||
    tab === 'vault' ||
    tab === 'workspaces' ||
    tab === 'source-control' ||
    tab === 'checks' ||
    tab === 'ports'
  ) {
    return tab
  }
  return getDefaultUIState().rightSidebarTab
}

function normalizeWorkspaceLineageByChildKey(
  value: unknown
): Record<WorkspaceKey, WorkspaceLineage> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const normalized: Record<WorkspaceKey, WorkspaceLineage> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!isWorkspaceKey(key) || !entry || typeof entry !== 'object') {
      continue
    }
    const lineage = entry as Partial<WorkspaceLineage>
    const childWorkspaceKey =
      typeof lineage.childWorkspaceKey === 'string' && isWorkspaceKey(lineage.childWorkspaceKey)
        ? lineage.childWorkspaceKey
        : key
    const parentWorkspaceKey = lineage.parentWorkspaceKey
    if (
      !isWorkspaceKey(childWorkspaceKey) ||
      typeof parentWorkspaceKey !== 'string' ||
      !isWorkspaceKey(parentWorkspaceKey) ||
      childWorkspaceKey !== key ||
      childWorkspaceKey === parentWorkspaceKey
    ) {
      continue
    }
    normalized[childWorkspaceKey] = {
      childWorkspaceKey,
      childInstanceId: lineage.childInstanceId ?? null,
      parentWorkspaceKey,
      parentInstanceId: lineage.parentInstanceId ?? null,
      origin: lineage.origin ?? 'cli',
      capture: lineage.capture ?? { source: 'manual-action', confidence: 'inferred' },
      ...(lineage.taskId ? { taskId: lineage.taskId } : {}),
      ...(lineage.orchestrationRunId ? { orchestrationRunId: lineage.orchestrationRunId } : {}),
      ...(lineage.coordinatorHandle ? { coordinatorHandle: lineage.coordinatorHandle } : {}),
      ...(lineage.createdByTerminalHandle
        ? { createdByTerminalHandle: lineage.createdByTerminalHandle }
        : {}),
      createdAt: Number.isFinite(lineage.createdAt) ? Number(lineage.createdAt) : Date.now()
    }
  }
  return normalized
}

function normalizeRightSidebarExplorerView(
  view: unknown,
  tab?: unknown
): PersistedState['ui']['rightSidebarExplorerView'] {
  // Why: older builds persisted Search as a standalone activity tab.
  if (tab === 'search') {
    return 'search'
  }
  if (view === 'files' || view === 'search') {
    return view
  }
  return getDefaultUIState().rightSidebarExplorerView
}

function normalizeNotificationSettings(value: unknown): NotificationSettings {
  const defaults = getDefaultNotificationSettings()
  const candidate =
    value && typeof value === 'object' ? (value as Partial<NotificationSettings>) : {}
  const rawSoundId = (candidate as { customSoundId?: unknown }).customSoundId
  const customSoundId =
    rawSoundId === 'system' ||
    rawSoundId === 'two-tone' ||
    rawSoundId === 'bong' ||
    rawSoundId === 'thump' ||
    rawSoundId === 'blip' ||
    rawSoundId === 'sonar' ||
    rawSoundId === 'blop' ||
    rawSoundId === 'ding' ||
    rawSoundId === 'clack' ||
    rawSoundId === 'beep' ||
    rawSoundId === 'custom'
      ? rawSoundId
      : rawSoundId === 'orca' || rawSoundId === 'chime'
        ? 'two-tone'
        : rawSoundId === 'pop'
          ? 'blop'
          : typeof candidate.customSoundPath === 'string'
            ? 'custom'
            : defaults.customSoundId
  const rawVolume = candidate.customSoundVolume
  const customSoundVolume =
    typeof rawVolume === 'number' && Number.isFinite(rawVolume)
      ? Math.min(100, Math.max(0, rawVolume))
      : defaults.customSoundVolume
  return {
    ...defaults,
    ...candidate,
    customSoundId,
    customSoundVolume
  }
}

function normalizeAutomationRunWorkspaceDisplayName(value: string | null): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function normalizeAutomationRunTerminalPaneKey(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed && parsePaneKey(trimmed) ? trimmed : null
}

function normalizeAutomationRunTerminalPtyId(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed || null
}

function normalizeAutomationRunOutputSnapshot(
  value: AutomationRunOutputSnapshot | null | undefined
): AutomationRunOutputSnapshot | null {
  if (!value || value.format !== 'plain_text') {
    return null
  }
  const content = typeof value.content === 'string' ? value.content : ''
  if (!content.trim()) {
    return null
  }
  return {
    format: 'plain_text',
    content,
    capturedAt:
      typeof value.capturedAt === 'number' && Number.isFinite(value.capturedAt)
        ? value.capturedAt
        : Date.now(),
    truncated: value.truncated === true
  }
}

function normalizeAutomationPrecheckResult(
  value: AutomationPrecheckResult | null | undefined
): AutomationPrecheckResult | null {
  if (!value || typeof value.command !== 'string' || !value.command.trim()) {
    return null
  }
  const startedAt =
    typeof value.startedAt === 'number' && Number.isFinite(value.startedAt)
      ? value.startedAt
      : Date.now()
  const completedAt =
    typeof value.completedAt === 'number' && Number.isFinite(value.completedAt)
      ? value.completedAt
      : startedAt
  return {
    command: value.command.trim(),
    exitCode:
      typeof value.exitCode === 'number' && Number.isFinite(value.exitCode) ? value.exitCode : null,
    timedOut: value.timedOut === true,
    durationMs:
      typeof value.durationMs === 'number' && Number.isFinite(value.durationMs)
        ? Math.max(0, value.durationMs)
        : Math.max(0, completedAt - startedAt),
    stdout: typeof value.stdout === 'string' ? value.stdout : '',
    stderr: typeof value.stderr === 'string' ? value.stderr : '',
    stdoutTruncated: value.stdoutTruncated === true,
    stderrTruncated: value.stderrTruncated === true,
    error: typeof value.error === 'string' && value.error.trim() ? value.error : null,
    startedAt,
    completedAt
  }
}

function normalizeAutomationSessionReuse(automation: Automation): Automation {
  const setupDecision = normalizeAutomationSetupDecisionForWorkspaceMode(
    automation.workspaceMode,
    automation.setupDecision
  )
  return {
    ...automation,
    precheck: normalizeAutomationPrecheck(automation.precheck),
    setupDecision,
    reuseSession: automation.workspaceMode === 'existing' && automation.reuseSession === true
  }
}

function normalizeAutomationSetupDecisionForWorkspaceMode(
  workspaceMode: Automation['workspaceMode'],
  setupDecision: unknown
): Automation['setupDecision'] {
  return workspaceMode === 'new_per_run' && (setupDecision === 'run' || setupDecision === 'skip')
    ? setupDecision
    : undefined
}

function getAutomationContextsForRepo(
  repo: Repo | undefined,
  projectHostSetups: readonly ProjectHostSetup[]
): Pick<Automation, 'runContext' | 'sourceContext'> {
  if (!repo) {
    return {
      runContext: null,
      sourceContext: null
    }
  }
  const projection = projectHostSetupProjectionFromRepos([repo])
  const projectedProject = projection.projects[0]
  const projectedSetup = projection.setups[0]
  const setup =
    projectHostSetups.find((candidate) => candidate.repoId === repo.id) ?? projectedSetup
  const runContext = setup
    ? buildWorkspaceRunContext({
        projectId: setup.projectId,
        hostId: setup.hostId,
        projectHostSetupId: setup.id,
        repoId: repo.id,
        path: setup.path
      })
    : null
  const providerIdentity = projectedProject?.providerIdentity
  const sourceContext = providerIdentity
    ? buildTaskSourceContextFromRepo({
        provider: providerIdentity.provider,
        projectId: providerIdentity.provider === 'github' ? (setup?.projectId ?? repo.id) : repo.id,
        repo,
        projectHostSetupId: setup?.id,
        providerIdentity
      })
    : null
  return {
    runContext,
    sourceContext
  }
}

function getAutomationSchedulerOwner(repo: Repo | undefined): AutomationSchedulerOwner {
  if (!repo) {
    return 'local_host_service'
  }
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  if (host?.kind === 'ssh') {
    return 'ssh_bridge'
  }
  if (host?.kind === 'runtime') {
    return 'remote_host_service'
  }
  return 'local_host_service'
}

function backfillLegacyAutomationContexts(
  state: Pick<PersistedState, 'automations' | 'automationRuns' | 'repos' | 'projectHostSetups'>
): {
  state: Pick<PersistedState, 'automations' | 'automationRuns' | 'repos' | 'projectHostSetups'>
  changed: boolean
} {
  let changed = false
  const contextsByAutomationId = new Map<string, Pick<Automation, 'runContext' | 'sourceContext'>>()
  const automations = (state.automations ?? []).map((automation) => {
    const contexts = getAutomationContextsForRepo(
      state.repos.find((repo) => repo.id === getAutomationLegacyRepoId(automation)),
      state.projectHostSetups ?? []
    )
    const next: Automation = { ...automation }
    if (!Object.hasOwn(next, 'runContext')) {
      // Why: pre-host-context automations only stored a repo id. Backfill the
      // explicit run target once so dispatch/precheck no longer infer it later.
      next.runContext = contexts.runContext
      changed = true
    }
    if (!Object.hasOwn(next, 'sourceContext')) {
      next.sourceContext = contexts.sourceContext
      changed = true
    }
    contextsByAutomationId.set(next.id, {
      runContext: next.runContext ?? null,
      sourceContext: next.sourceContext ?? null
    })
    return next
  })
  const automationRuns = (state.automationRuns ?? []).map((run) => {
    const automationContexts = contextsByAutomationId.get(run.automationId)
    const next: AutomationRun = { ...run }
    if (!Object.hasOwn(next, 'runContext')) {
      next.runContext = automationContexts?.runContext ?? null
      changed = true
    }
    if (!Object.hasOwn(next, 'sourceContext')) {
      next.sourceContext = automationContexts?.sourceContext ?? null
      changed = true
    }
    if (!Object.hasOwn(next, 'terminalPaneKey')) {
      next.terminalPaneKey = null
      changed = true
    }
    if (!Object.hasOwn(next, 'terminalPtyId')) {
      next.terminalPtyId = null
      changed = true
    }
    return next
  })
  if (!changed) {
    return { state, changed: false }
  }
  return {
    state: {
      ...state,
      automations,
      automationRuns
    },
    changed: true
  }
}

type LegacySshTarget = SshTarget & {
  remoteWorkspaceSyncEnabled?: unknown
  remoteWorkspaceSyncGracePeriodSeconds?: unknown
}

// Why: old persisted targets predate configHost. Default to label-based lookup
// so imported SSH aliases keep resolving through ssh -G after upgrade.
function normalizeSshTarget(t: SshTarget): SshTarget {
  const target = { ...(t as LegacySshTarget) }
  const legacySyncEnabled = target.remoteWorkspaceSyncEnabled
  const currentGracePeriodSeconds = target.relayGracePeriodSeconds
  const legacyGracePeriodSeconds = target.remoteWorkspaceSyncGracePeriodSeconds
  const systemSshConnectionReuse = target.systemSshConnectionReuse
  // Why: remote workspace sync now follows the SSH relay lifecycle, so the
  // retired per-target sync opt-out and grace-period fields stop at disk load.
  delete target.remoteWorkspaceSyncEnabled
  delete target.remoteWorkspaceSyncGracePeriodSeconds
  delete target.relayGracePeriodSeconds
  delete target.systemSshConnectionReuse
  // Why: synced legacy targets ignored stale relayGracePeriodSeconds values.
  // Prefer the synced grace so a user's "unlimited" (0) survives migration.
  const relayGracePeriodSeconds =
    legacySyncEnabled === true && typeof legacyGracePeriodSeconds === 'number'
      ? legacyGracePeriodSeconds
      : currentGracePeriodSeconds
  const normalized: SshTarget = {
    ...target,
    configHost: target.configHost ?? target.label ?? target.host
  }
  // Why: the old SSH form eagerly persisted 10800 even when the user had not
  // chosen a timeout; treat that legacy default as the new implicit default.
  if (
    relayGracePeriodSeconds !== undefined &&
    relayGracePeriodSeconds !== LEGACY_DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS
  ) {
    normalized.relayGracePeriodSeconds = relayGracePeriodSeconds
  }
  if (systemSshConnectionReuse === false) {
    normalized.systemSshConnectionReuse = false
  }
  return normalized
}

// Why: shared by load-time merge and the IPC update handler so the same
// strict whitelist guards every entry into onboarding state — arbitrary
// renderer/disk input cannot inject unknown keys or wrong-typed values.
// Returns only validated fields; unknown keys are dropped silently.
// Why: returns Partial<...> with a partial checklist so the IPC update path
// merges over current state without wiping previously-true keys. Invalid
// top-level fields are OMITTED (not coerced to fallbacks) so partial updates
// don't clobber valid persisted state; the load-path caller spreads defaults.
type SanitizeOnboardingUpdateOptions = {
  migrateLegacyProgress?: boolean
}

function remapLegacyOnboardingLastCompletedStep(
  lastCompletedStep: number,
  raw: Record<string, unknown>
): number {
  if (raw.outcome === 'completed' && lastCompletedStep >= 4) {
    return ONBOARDING_FINAL_STEP
  }
  // Why: v3 was the four-step flow before the Windows terminal preference
  // page. Step 4 already meant notifications, so open progress should resume
  // there rather than treating it as the newly inserted Windows step.
  if (raw.flowVersion === 3) {
    return Math.min(4, lastCompletedStep)
  }
  // Why: v2 was the five-step flow; missing/older versions were seven-step
  // data where step 4 was removed agent setup, not completed integrations.
  if (raw.flowVersion === 2) {
    if (lastCompletedStep === 3) {
      return 2
    }
    if (lastCompletedStep >= 4) {
      return 3
    }
    return lastCompletedStep
  }
  if (lastCompletedStep === 3) {
    return 2
  }
  if (lastCompletedStep === 4) {
    return 2
  }
  if (lastCompletedStep >= 5) {
    return 3
  }
  return lastCompletedStep
}

export function sanitizeOnboardingUpdate(
  input: unknown,
  options: SanitizeOnboardingUpdateOptions = {}
): Partial<Omit<OnboardingState, 'checklist'>> & { checklist?: Partial<OnboardingChecklistState> } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {}
  }
  const raw = input as Record<string, unknown>
  const out: Partial<Omit<OnboardingState, 'checklist'>> & {
    checklist?: Partial<OnboardingChecklistState>
  } = {}

  if ('closedAt' in raw) {
    // Why: `typeof raw.closedAt === 'number'` would let NaN/Infinity through;
    // JSON.stringify writes those as `null` on save, which silently reverts
    // closedAt and re-opens the wizard on next load. Require a finite,
    // non-negative timestamp so live state matches what disk can persist.
    if (typeof raw.closedAt === 'number' && Number.isFinite(raw.closedAt) && raw.closedAt >= 0) {
      out.closedAt = raw.closedAt
    } else if (raw.closedAt === null) {
      out.closedAt = null
    }
    // else: omit — preserve existing persisted value on merge.
  }
  if ('outcome' in raw) {
    const v = raw.outcome
    if (v === 'completed' || v === 'dismissed') {
      out.outcome = v as OnboardingOutcome
    } else if (v === null) {
      out.outcome = null
    }
    // else: omit.
  }
  if ('flowVersion' in raw) {
    const v = raw.flowVersion
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= ONBOARDING_FLOW_VERSION) {
      out.flowVersion = v
    }
    // else: omit.
  }
  if ('lastCompletedStep' in raw) {
    const v = raw.lastCompletedStep
    if (typeof v === 'number' && Number.isInteger(v) && v >= -1) {
      const isLegacyFlow =
        options.migrateLegacyProgress && raw.flowVersion !== ONBOARDING_FLOW_VERSION
      // Why: removing two wizard pages changed numeric meanings. Migrate raw
      // legacy disk values before the new final-step bound can drop them.
      const normalized = isLegacyFlow ? remapLegacyOnboardingLastCompletedStep(v, raw) : v
      if (normalized <= ONBOARDING_FINAL_STEP) {
        out.lastCompletedStep = normalized
      }
    }
    // else: omit.
  }
  if ('checklist' in raw) {
    const rawChecklist = raw.checklist
    if (rawChecklist && typeof rawChecklist === 'object' && !Array.isArray(rawChecklist)) {
      // Why: copy ONLY caller-sent boolean keys so partial updates (e.g.
      // `{ addedRepo: true }`) don't reset other checklist items to false.
      const defaults = getDefaultOnboardingState().checklist
      const rc = rawChecklist as Record<string, unknown>
      const checklist: Partial<OnboardingChecklistState> = {}
      for (const key of Object.keys(defaults) as (keyof OnboardingChecklistState)[]) {
        if (key in rc && typeof rc[key] === 'boolean') {
          checklist[key] = rc[key] as boolean
        }
      }
      out.checklist = checklist
    }
  }
  if (options.migrateLegacyProgress) {
    out.flowVersion = ONBOARDING_FLOW_VERSION
  }
  return out
}

function normalizeLoadedOnboardingState(
  input: unknown,
  defaults: OnboardingState
): OnboardingState {
  // Why: if we successfully parsed an existing orca-data.json that lacks an
  // onboarding block, this is an upgrade-cohort user — backfill as completed
  // (not dismissed) so they don't get dropped into the wizard regardless of
  // whether they currently have repos, SSH targets, or just non-default
  // settings. Analytics still distinguish this from users who explicitly
  // bailed mid-funnel.
  if (!input) {
    return {
      ...defaults,
      closedAt: Date.now(),
      outcome: 'completed',
      lastCompletedStep: ONBOARDING_FINAL_STEP
    }
  }
  // Why: validate every persisted onboarding key explicitly via the shared
  // sanitizer instead of spreading raw values. A type-flipped field on disk
  // (string where number expected, unknown checklist key) is dropped or
  // coerced to the default rather than poisoning in-memory state.
  const sanitized = sanitizeOnboardingUpdate(input, {
    migrateLegacyProgress: true
  })
  // Why: a persisted completed/dismissed outcome means the user left
  // onboarding. Recover from a bad/missing/null closedAt instead of reopening
  // the new-user sidebar checklist.
  const recoveredClosedAt =
    typeof sanitized.closedAt === 'number'
      ? sanitized.closedAt
      : sanitized.outcome !== null && sanitized.outcome !== undefined
        ? Date.now()
        : sanitized.closedAt
  return {
    ...defaults,
    ...sanitized,
    closedAt: recoveredClosedAt ?? defaults.closedAt,
    checklist: {
      ...defaults.checklist,
      ...sanitized.checklist
    }
  }
}

function resolveSetupGuideSidebarDismissedOnLoad(
  persistedDismissed: unknown,
  onboarding: OnboardingState
): boolean {
  // Why: the sidebar checklist is a new-user prompt. Once onboarding is
  // closed, persisted false is just the old default value, not a user opt-in.
  return onboarding.closedAt !== null || persistedDismissed === true
}

function shouldDefaultNewWorktreeCardStyleOn(onboarding: OnboardingState): boolean {
  return onboarding.closedAt === null
}

// Why: read a settings field that was removed from GlobalSettings but can
// still exist on disk. One-shot use for the inline-agents migration.
function readDeprecatedExperimentFlag(parsed: PersistedState | undefined): boolean {
  return (
    (parsed?.settings as { experimentalAgentDashboard?: boolean } | undefined)
      ?.experimentalAgentDashboard === true
  )
}

function readLegacySidekickFlag(parsed: PersistedState | undefined): boolean | undefined {
  return (parsed?.settings as { experimentalSidekick?: boolean } | undefined)?.experimentalSidekick
}

function sanitizeRepoUpstream(value: unknown): Repo['upstream'] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return null
  }
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const candidate = value as { owner?: unknown; repo?: unknown }
  const owner = typeof candidate.owner === 'string' ? candidate.owner.trim() : ''
  const repo = typeof candidate.repo === 'string' ? candidate.repo.trim() : ''
  return owner && repo ? { owner, repo } : undefined
}

function sanitizeGitRemoteIdentity(value: unknown): GitRemoteIdentity | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const candidate = value as {
    canonicalKey?: unknown
    remoteName?: unknown
    remoteUrl?: unknown
  }
  const canonicalKey =
    typeof candidate.canonicalKey === 'string' ? candidate.canonicalKey.trim() : ''
  const remoteName = typeof candidate.remoteName === 'string' ? candidate.remoteName.trim() : ''
  const remoteUrl = typeof candidate.remoteUrl === 'string' ? candidate.remoteUrl.trim() : ''
  return canonicalKey && remoteName && remoteUrl
    ? { canonicalKey, remoteName, remoteUrl }
    : undefined
}

function sanitizeRepoProjectHostSetupMethod(
  value: unknown
): RepoProjectHostSetupMethod | undefined {
  return value === 'imported-existing-folder' || value === 'cloned' ? value : undefined
}

function sanitizeForkSyncMode(value: unknown): Repo['forkSyncMode'] | undefined {
  return value === 'ask' || value === 'safe-auto' || value === 'off' ? value : undefined
}

function sanitizeRepoUpdatesForPersistence<
  T extends Partial<
    Pick<
      Repo,
      | 'badgeColor'
      | 'repoIcon'
      | 'upstream'
      | 'gitRemoteIdentity'
      | 'worktreeBasePath'
      | 'projectHostSetupMethod'
      | 'forkSyncMode'
    >
  >
>(updates: T): T {
  const sanitized = { ...updates }
  if ('badgeColor' in sanitized) {
    const badgeColor = normalizeRepoBadgeColor(sanitized.badgeColor)
    if (!badgeColor) {
      delete sanitized.badgeColor
    } else {
      sanitized.badgeColor = badgeColor
    }
  }
  if ('repoIcon' in sanitized) {
    const repoIcon = sanitizeRepoIcon(sanitized.repoIcon)
    if (repoIcon === undefined) {
      delete sanitized.repoIcon
    } else {
      sanitized.repoIcon = repoIcon
    }
  }
  // Why: `null` is a valid "not a fork" marker; only drop malformed shapes.
  if ('upstream' in sanitized) {
    const upstream = sanitizeRepoUpstream(sanitized.upstream)
    if (upstream === undefined) {
      delete sanitized.upstream
    } else {
      sanitized.upstream = upstream
    }
  }
  if ('gitRemoteIdentity' in sanitized) {
    const gitRemoteIdentity = sanitizeGitRemoteIdentity(sanitized.gitRemoteIdentity)
    if (gitRemoteIdentity === undefined) {
      delete sanitized.gitRemoteIdentity
    } else {
      sanitized.gitRemoteIdentity = gitRemoteIdentity
    }
  }
  if ('worktreeBasePath' in sanitized && sanitized.worktreeBasePath !== undefined) {
    if (typeof sanitized.worktreeBasePath === 'string') {
      sanitized.worktreeBasePath = sanitized.worktreeBasePath.trim() || undefined
    } else {
      delete sanitized.worktreeBasePath
    }
  }
  if ('projectHostSetupMethod' in sanitized) {
    const setupMethod = sanitizeRepoProjectHostSetupMethod(sanitized.projectHostSetupMethod)
    if (setupMethod === undefined) {
      delete sanitized.projectHostSetupMethod
    } else {
      sanitized.projectHostSetupMethod = setupMethod
    }
  }
  if ('forkSyncMode' in sanitized) {
    const forkSyncMode = sanitizeForkSyncMode(sanitized.forkSyncMode)
    if (forkSyncMode === undefined) {
      delete sanitized.forkSyncMode
    } else {
      sanitized.forkSyncMode = forkSyncMode
    }
  }
  return sanitized
}

function expandFloatingWorkspaceHomePath(input: string, home: string): string {
  if (input === '~') {
    return home
  }
  if (input.startsWith(`~${sep}`) || (process.platform === 'win32' && input.startsWith('~/'))) {
    return join(home, input.slice(2))
  }
  return input
}

function resolveFloatingWorkspacePath(input: string, home: string): string {
  const expanded = expandFloatingWorkspaceHomePath(input, home)
  return isAbsolute(expanded) ? resolve(expanded) : resolve(home, expanded)
}

function canonicalizePersistedFloatingWorkspaceDirectory(
  input: string,
  home: string
): string | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }
  try {
    const canonicalPath = resolve(realpathSync(resolveFloatingWorkspacePath(trimmed, home)))
    return statSync(canonicalPath).isDirectory() ? canonicalPath : null
  } catch {
    return null
  }
}

function normalizeFloatingWorkspaceTrustedCwds(
  input: unknown,
  home: string
): { trustedCwds: string[]; changed: boolean } {
  const rawTrustedCwds = Array.isArray(input) ? input : []
  const trustedCwds: string[] = []
  const seen = new Set<string>()
  let changed = input !== undefined && !Array.isArray(input)

  for (const rawTrustedCwd of rawTrustedCwds) {
    if (typeof rawTrustedCwd !== 'string') {
      changed = true
      continue
    }
    const trimmedTrustedCwd = rawTrustedCwd.trim()
    if (!trimmedTrustedCwd) {
      changed = true
      continue
    }
    const canonicalPath = canonicalizePersistedFloatingWorkspaceDirectory(trimmedTrustedCwd, home)
    const normalizedPath = canonicalPath ?? resolveFloatingWorkspacePath(trimmedTrustedCwd, home)
    if (!normalizedPath) {
      changed = true
      continue
    }
    if (seen.has(normalizedPath)) {
      changed = true
      continue
    }
    seen.add(normalizedPath)
    trustedCwds.push(normalizedPath)
    if (rawTrustedCwd !== normalizedPath) {
      changed = true
    }
  }

  return { trustedCwds, changed }
}

function normalizeSshRemotePtyLease(value: unknown): SshRemotePtyLease | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const raw = value as Partial<SshRemotePtyLease>
  if (typeof raw.targetId !== 'string' || typeof raw.ptyId !== 'string') {
    return null
  }
  const state = raw.state ?? 'detached'
  if (!['attached', 'detached', 'terminated', 'expired'].includes(state)) {
    return null
  }
  const now = Date.now()
  return {
    targetId: raw.targetId,
    ptyId: raw.ptyId,
    ...(typeof raw.worktreeId === 'string' ? { worktreeId: raw.worktreeId } : {}),
    ...(typeof raw.tabId === 'string' ? { tabId: raw.tabId } : {}),
    ...(typeof raw.leafId === 'string' && raw.leafId.length <= 256 ? { leafId: raw.leafId } : {}),
    state,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
    ...(typeof raw.lastAttachedAt === 'number' ? { lastAttachedAt: raw.lastAttachedAt } : {}),
    ...(typeof raw.lastDetachedAt === 'number' ? { lastDetachedAt: raw.lastDetachedAt } : {})
  }
}

type LayoutLeafNormalization = {
  snapshot: TerminalLayoutSnapshot
  changed: boolean
  leafIdByInputLeafId: Map<string, string>
}

function collectLayoutLeafCounts(
  node: TerminalPaneLayoutNode,
  counts: Map<string, number> = new Map()
): Map<string, number> {
  if (node.type === 'leaf') {
    counts.set(node.leafId, (counts.get(node.leafId) ?? 0) + 1)
    return counts
  }
  collectLayoutLeafCounts(node.first, counts)
  collectLayoutLeafCounts(node.second, counts)
  return counts
}

function collectLayoutLeafIdsInOrder(node: TerminalPaneLayoutNode | null | undefined): string[] {
  if (!node) {
    return []
  }
  if (node.type === 'leaf') {
    return [node.leafId]
  }
  return [...collectLayoutLeafIdsInOrder(node.first), ...collectLayoutLeafIdsInOrder(node.second)]
}

function firstLayoutLeafId(node: TerminalPaneLayoutNode | null): string | null {
  if (!node) {
    return null
  }
  return node.type === 'leaf' ? node.leafId : firstLayoutLeafId(node.first)
}

function layoutContainsLeafId(node: TerminalPaneLayoutNode | null, leafId: string): boolean {
  if (!node) {
    return false
  }
  if (node.type === 'leaf') {
    return node.leafId === leafId
  }
  return layoutContainsLeafId(node.first, leafId) || layoutContainsLeafId(node.second, leafId)
}

function cloneLayoutNode(node: TerminalPaneLayoutNode): TerminalPaneLayoutNode {
  if (node.type === 'leaf') {
    return { type: 'leaf', leafId: node.leafId }
  }
  return {
    ...node,
    first: cloneLayoutNode(node.first),
    second: cloneLayoutNode(node.second)
  }
}

function cloneLayoutWithLeafIds(
  node: TerminalPaneLayoutNode,
  leafIdByInputLeafId: Map<string, string>,
  duplicatedInputLeafIds: Set<string>
): TerminalPaneLayoutNode {
  if (node.type === 'leaf') {
    return {
      type: 'leaf',
      leafId: duplicatedInputLeafIds.has(node.leafId)
        ? randomUUID()
        : (leafIdByInputLeafId.get(node.leafId) ?? randomUUID())
    }
  }
  return {
    ...node,
    first: cloneLayoutWithLeafIds(node.first, leafIdByInputLeafId, duplicatedInputLeafIds),
    second: cloneLayoutWithLeafIds(node.second, leafIdByInputLeafId, duplicatedInputLeafIds)
  }
}

function remapLeafRecordForPersistence(
  source: Record<string, string> | undefined,
  leafIdByInputLeafId: Map<string, string>,
  duplicatedInputLeafIds: Set<string>
): Record<string, string> | undefined {
  if (!source) {
    return undefined
  }
  const next: Record<string, string> = {}
  for (const [leafId, value] of Object.entries(source)) {
    if (duplicatedInputLeafIds.has(leafId)) {
      continue
    }
    const nextLeafId = leafIdByInputLeafId.get(leafId)
    if (nextLeafId) {
      next[nextLeafId] = value
    }
  }
  return Object.keys(next).length > 0 ? next : undefined
}

function leafRecordEquivalent(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined
): boolean {
  const leftEntries = Object.entries(left ?? {})
  const rightRecord = right ?? {}
  if (leftEntries.length !== Object.keys(rightRecord).length) {
    return false
  }
  return leftEntries.every(([key, value]) => rightRecord[key] === value)
}

function preserveMissingLeafRecordEntries(
  priorRecord: Record<string, string> | undefined,
  incomingRecord: Record<string, string> | undefined,
  liveLeafIds: Set<string>
): Record<string, string> | undefined {
  const preserved = Object.fromEntries(
    Object.entries(priorRecord ?? {}).filter(
      ([leafId]) => liveLeafIds.has(leafId) && incomingRecord?.[leafId] === undefined
    )
  )
  const next = { ...preserved, ...incomingRecord }
  return Object.keys(next).length > 0 ? next : undefined
}

function findWorktreeIdForTab(session: WorkspaceSessionState, tabId: string): string | undefined {
  for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree ?? {})) {
    if (tabs.some((tab) => tab.id === tabId)) {
      return worktreeId
    }
  }
  return undefined
}

type PaneIdentityMigrationEntries = {
  migrationUnsupportedEntries: MigrationUnsupportedPtyEntry[]
  legacyPaneKeyAliasEntries: LegacyPaneKeyAliasEntry[]
}

function collectMigrationUnsupportedPtyEntries(args: {
  session: WorkspaceSessionState
  tabId: string
  inputLayout: TerminalLayoutSnapshot
  normalizedLayout: TerminalLayoutSnapshot
  leafIdByInputLeafId: Map<string, string>
}): PaneIdentityMigrationEntries {
  const worktreeId = findWorktreeIdForTab(args.session, args.tabId)
  const tab = worktreeId
    ? args.session.tabsByWorktree?.[worktreeId]?.find((entry) => entry.id === args.tabId)
    : undefined
  const legacyPaneKeyAliasEntries: LegacyPaneKeyAliasEntry[] = []
  const registeredLegacyPaneKeys = new Set<string>()
  const hasLeafPtyBindings = Object.keys(args.inputLayout.ptyIdsByLeafId ?? {}).length > 0
  const fallbackPtyId =
    !hasLeafPtyBindings && typeof tab?.ptyId === 'string' ? tab.ptyId : undefined
  const registerLegacyAlias = (inputLeafId: string, leafId: string, ptyId?: string): boolean => {
    if (!isTerminalLeafId(leafId)) {
      return false
    }
    let paneKey: string
    try {
      paneKey = makePaneKey(args.tabId, leafId)
    } catch {
      return false
    }
    const numeric = /^(?:pane:)?(\d+)$/.exec(inputLeafId)?.[1]
    if (!numeric) {
      return false
    }
    // Why: persisted PaneManager ids are 1-based. A zero-based alias in split
    // layouts would make tab:1 ambiguous and can route the first pane to the second.
    const legacyPaneKey = `${args.tabId}:${numeric}`
    agentHookServer.registerPaneKeyAlias(legacyPaneKey, paneKey, ptyId)
    registeredLegacyPaneKeys.add(legacyPaneKey)
    if (ptyId) {
      legacyPaneKeyAliasEntries.push({
        ptyId,
        legacyPaneKey,
        stablePaneKey: paneKey,
        updatedAt: Date.now()
      })
      return true
    }
    return false
  }
  const inputLeafIds = new Set([
    ...collectLayoutLeafIdsInOrder(args.inputLayout.root),
    ...Object.keys(args.inputLayout.ptyIdsByLeafId ?? {})
  ])
  for (const inputLeafId of inputLeafIds) {
    if (isTerminalLeafId(inputLeafId)) {
      continue
    }
    const leafId = args.leafIdByInputLeafId.get(inputLeafId)
    if (leafId) {
      registerLegacyAlias(
        inputLeafId,
        leafId,
        args.inputLayout.ptyIdsByLeafId?.[inputLeafId] ?? fallbackPtyId
      )
    }
  }
  if (tab?.ptyId && !hasLeafPtyBindings) {
    const fallbackLeafId =
      args.normalizedLayout.activeLeafId ?? firstLayoutLeafId(args.normalizedLayout.root)
    if (fallbackLeafId && isTerminalLeafId(fallbackLeafId)) {
      const paneKey = makePaneKey(args.tabId, fallbackLeafId)
      for (const legacyPaneKey of [`${args.tabId}:0`, `${args.tabId}:1`]) {
        if (registeredLegacyPaneKeys.has(legacyPaneKey)) {
          continue
        }
        agentHookServer.registerPaneKeyAlias(legacyPaneKey, paneKey, tab.ptyId)
        legacyPaneKeyAliasEntries.push({
          ptyId: tab.ptyId,
          legacyPaneKey,
          stablePaneKey: paneKey,
          updatedAt: Date.now()
        })
      }
    }
  }
  // Why: legacy numeric pane keys are now bridged by aliases instead of
  // persisted as restart-required rows. Existing saved rows are pruned during
  // normalizePersistedPaneIdentityState.
  return { migrationUnsupportedEntries: [], legacyPaneKeyAliasEntries }
}

function legacyMigrationUnsupportedRowsToAliasEntries(
  entries: MigrationUnsupportedPtyEntry[]
): LegacyPaneKeyAliasEntry[] {
  const normalizedEntries = normalizeMigrationUnsupportedPtyEntries(entries).filter(
    (entry) => entry.tabId && entry.paneKey && parsePaneKey(entry.paneKey)
  )
  const entriesByTabId = new Map<string, MigrationUnsupportedPtyEntry[]>()
  for (const entry of normalizedEntries) {
    const tabId = entry.tabId
    if (!tabId) {
      continue
    }
    entriesByTabId.set(tabId, [...(entriesByTabId.get(tabId) ?? []), entry])
  }
  const aliasEntries: LegacyPaneKeyAliasEntry[] = []
  for (const [tabId, tabEntries] of entriesByTabId) {
    if (tabEntries.length !== 1) {
      continue
    }
    const [entry] = tabEntries
    if (!entry.paneKey) {
      continue
    }
    // Why: pre-stable dev/RC migration rows did not store the old numeric
    // key. Only synthesize the single-pane aliases when the row is unambiguous
    // for its tab; split rows need layout-derived aliases instead of a guess.
    for (const legacyPaneKey of [`${tabId}:0`, `${tabId}:1`]) {
      aliasEntries.push({
        ptyId: entry.ptyId,
        legacyPaneKey,
        stablePaneKey: entry.paneKey,
        updatedAt: entry.updatedAt
      })
    }
  }
  return aliasEntries
}

function normalizeTerminalLayoutSnapshotForPersistence(
  snapshot: TerminalLayoutSnapshot,
  preferredLayout?: TerminalLayoutSnapshot
): LayoutLeafNormalization {
  let inputSnapshot = snapshot
  let changed = false
  if (!inputSnapshot.root) {
    if (!preferredLayout?.root) {
      return { snapshot, changed: false, leafIdByInputLeafId: new Map() }
    }
    const root = cloneLayoutNode(preferredLayout.root)
    const rootLeafIds = new Set(collectLayoutLeafIdsInOrder(root))
    const activeLeafId =
      (inputSnapshot.activeLeafId && rootLeafIds.has(inputSnapshot.activeLeafId)
        ? inputSnapshot.activeLeafId
        : null) ??
      (preferredLayout.activeLeafId && rootLeafIds.has(preferredLayout.activeLeafId)
        ? preferredLayout.activeLeafId
        : null) ??
      firstLayoutLeafId(root)
    const expandedLeafId =
      (inputSnapshot.expandedLeafId && rootLeafIds.has(inputSnapshot.expandedLeafId)
        ? inputSnapshot.expandedLeafId
        : null) ??
      (preferredLayout.expandedLeafId && rootLeafIds.has(preferredLayout.expandedLeafId)
        ? preferredLayout.expandedLeafId
        : null)
    inputSnapshot = { ...inputSnapshot, root, activeLeafId, expandedLeafId }
    // Why: a debounced renderer writer can still hold the createTab-era empty
    // layout after persistPtyBinding has already sync-flushed the UUID root.
    changed = true
  }
  const inputRoot = inputSnapshot.root
  if (!inputRoot) {
    return { snapshot, changed: false, leafIdByInputLeafId: new Map() }
  }
  const counts = collectLayoutLeafCounts(inputRoot)
  const duplicatedInputLeafIds = new Set(
    Array.from(counts.entries())
      .filter(([, count]) => count > 1)
      .map(([leafId]) => leafId)
  )
  const inputLeafIdsInOrder = collectLayoutLeafIdsInOrder(inputRoot)
  const preferredLeafIdsInOrder = collectLayoutLeafIdsInOrder(preferredLayout?.root)
  const usePreferredLeafIds = preferredLeafIdsInOrder.length === inputLeafIdsInOrder.length
  const leafIdByInputLeafId = new Map<string, string>()
  for (const [index, leafId] of inputLeafIdsInOrder.entries()) {
    const count = counts.get(leafId) ?? 0
    if (count !== 1 || leafIdByInputLeafId.has(leafId)) {
      changed = true
      continue
    }
    if (isTerminalLeafId(leafId)) {
      leafIdByInputLeafId.set(leafId, leafId)
      continue
    }
    changed = true
    const preferredLeafId = usePreferredLeafIds ? preferredLeafIdsInOrder[index] : undefined
    leafIdByInputLeafId.set(
      leafId,
      preferredLeafId && isTerminalLeafId(preferredLeafId) ? preferredLeafId : randomUUID()
    )
  }
  const root = changed
    ? cloneLayoutWithLeafIds(inputRoot, leafIdByInputLeafId, duplicatedInputLeafIds)
    : inputRoot
  const activeLeafId =
    inputSnapshot.activeLeafId && !duplicatedInputLeafIds.has(inputSnapshot.activeLeafId)
      ? (leafIdByInputLeafId.get(inputSnapshot.activeLeafId) ?? firstLayoutLeafId(root))
      : inputSnapshot.activeLeafId === null
        ? null
        : firstLayoutLeafId(root)
  const expandedLeafId =
    inputSnapshot.expandedLeafId && !duplicatedInputLeafIds.has(inputSnapshot.expandedLeafId)
      ? (leafIdByInputLeafId.get(inputSnapshot.expandedLeafId) ?? null)
      : null
  const ptyIdsByLeafId = remapLeafRecordForPersistence(
    inputSnapshot.ptyIdsByLeafId,
    leafIdByInputLeafId,
    duplicatedInputLeafIds
  )
  const buffersByLeafId = remapLeafRecordForPersistence(
    inputSnapshot.buffersByLeafId,
    leafIdByInputLeafId,
    duplicatedInputLeafIds
  )
  const scrollbackRefsByLeafId = remapLeafRecordForPersistence(
    inputSnapshot.scrollbackRefsByLeafId,
    leafIdByInputLeafId,
    duplicatedInputLeafIds
  )
  const titlesByLeafId = remapLeafRecordForPersistence(
    inputSnapshot.titlesByLeafId,
    leafIdByInputLeafId,
    duplicatedInputLeafIds
  )
  const recordsChanged =
    !leafRecordEquivalent(inputSnapshot.ptyIdsByLeafId, ptyIdsByLeafId) ||
    !leafRecordEquivalent(inputSnapshot.buffersByLeafId, buffersByLeafId) ||
    !leafRecordEquivalent(inputSnapshot.scrollbackRefsByLeafId, scrollbackRefsByLeafId) ||
    !leafRecordEquivalent(inputSnapshot.titlesByLeafId, titlesByLeafId)
  const metadataChanged =
    activeLeafId !== inputSnapshot.activeLeafId || expandedLeafId !== inputSnapshot.expandedLeafId
  if (!changed && !recordsChanged && !metadataChanged) {
    return { snapshot, changed: false, leafIdByInputLeafId }
  }
  const {
    ptyIdsByLeafId: _oldPtyIdsByLeafId,
    buffersByLeafId: _oldBuffersByLeafId,
    scrollbackRefsByLeafId: _oldScrollbackRefsByLeafId,
    titlesByLeafId: _oldTitlesByLeafId,
    ...snapshotWithoutLeafRecords
  } = inputSnapshot
  return {
    snapshot: {
      ...snapshotWithoutLeafRecords,
      root,
      activeLeafId,
      expandedLeafId,
      ...(ptyIdsByLeafId ? { ptyIdsByLeafId } : {}),
      ...(buffersByLeafId ? { buffersByLeafId } : {}),
      ...(scrollbackRefsByLeafId ? { scrollbackRefsByLeafId } : {}),
      ...(titlesByLeafId ? { titlesByLeafId } : {})
    },
    changed: true,
    leafIdByInputLeafId
  }
}

function normalizeWorkspaceSessionPaneIdentities(
  session: WorkspaceSessionState,
  priorLayoutsByTabId: Record<string, TerminalLayoutSnapshot> = {}
): {
  session: WorkspaceSessionState
  changed: boolean
  leafIdByInputLeafIdByTabId: Map<string, Map<string, string>>
  leafIdByPtyIdByTabId: Map<string, Map<string, string>>
  migrationUnsupportedEntries: MigrationUnsupportedPtyEntry[]
  legacyPaneKeyAliasEntries: LegacyPaneKeyAliasEntry[]
} {
  let changed = false
  const leafIdByInputLeafIdByTabId = new Map<string, Map<string, string>>()
  const leafIdByPtyIdByTabId = new Map<string, Map<string, string>>()
  const migrationUnsupportedEntries: MigrationUnsupportedPtyEntry[] = []
  const legacyPaneKeyAliasEntries: LegacyPaneKeyAliasEntry[] = []
  const terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot> = {}
  for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId ?? {})) {
    const normalized = normalizeTerminalLayoutSnapshotForPersistence(
      layout,
      priorLayoutsByTabId[tabId]
    )
    terminalLayoutsByTabId[tabId] = normalized.snapshot
    leafIdByInputLeafIdByTabId.set(tabId, normalized.leafIdByInputLeafId)
    const migrationEntries = collectMigrationUnsupportedPtyEntries({
      session,
      tabId,
      inputLayout: layout,
      normalizedLayout: normalized.snapshot,
      leafIdByInputLeafId: normalized.leafIdByInputLeafId
    })
    // Why: old persisted split layouts can generate enough alias rows to
    // exceed V8's argument limit if the arrays are spread into push().
    for (const entry of migrationEntries.migrationUnsupportedEntries) {
      migrationUnsupportedEntries.push(entry)
    }
    for (const entry of migrationEntries.legacyPaneKeyAliasEntries) {
      legacyPaneKeyAliasEntries.push(entry)
    }
    const leafIdByPtyId = new Map<string, string>()
    const duplicatePtyIds = new Set<string>()
    for (const [leafId, ptyId] of Object.entries(normalized.snapshot.ptyIdsByLeafId ?? {})) {
      if (duplicatePtyIds.has(ptyId)) {
        continue
      }
      if (leafIdByPtyId.has(ptyId)) {
        leafIdByPtyId.delete(ptyId)
        duplicatePtyIds.add(ptyId)
        continue
      }
      leafIdByPtyId.set(ptyId, leafId)
    }
    leafIdByPtyIdByTabId.set(tabId, leafIdByPtyId)
    changed ||= normalized.changed
  }
  return {
    session: changed ? { ...session, terminalLayoutsByTabId } : session,
    changed,
    leafIdByInputLeafIdByTabId,
    leafIdByPtyIdByTabId,
    migrationUnsupportedEntries,
    legacyPaneKeyAliasEntries
  }
}

function remapSshRemotePtyLeaseLeafIds(
  leases: SshRemotePtyLease[],
  leafIdByInputLeafIdByTabId: Map<string, Map<string, string>>,
  leafIdByPtyIdByTabId: Map<string, Map<string, string>>
): { leases: SshRemotePtyLease[]; changed: boolean } {
  let changed = false
  const nextLeases = leases.map((lease) => {
    if (lease.leafId === undefined || isTerminalLeafId(lease.leafId)) {
      return lease
    }
    const remappedLeafId = lease.tabId
      ? leafIdByInputLeafIdByTabId.get(lease.tabId)?.get(lease.leafId)
      : undefined
    const leafIdForPty = lease.tabId
      ? leafIdByPtyIdByTabId.get(lease.tabId)?.get(lease.ptyId)
      : undefined
    changed = true
    const nextLeafId = remappedLeafId ?? leafIdForPty
    if (nextLeafId) {
      return { ...lease, leafId: nextLeafId }
    }
    const next = { ...lease }
    // Why: unmatched legacy leaf ids are ambiguous after migration; do not
    // re-persist them as durable pane identity.
    delete next.leafId
    return next
  })
  return { leases: nextLeases, changed }
}

function normalizePersistedPaneIdentityState(state: PersistedState): {
  state: PersistedState
  changed: boolean
  migrationUnsupportedEntries: MigrationUnsupportedPtyEntry[]
  legacyPaneKeyAliasEntries: LegacyPaneKeyAliasEntry[]
} {
  const normalizedSession = normalizeWorkspaceSessionPaneIdentities(state.workspaceSession, {})
  const remappedLeases = remapSshRemotePtyLeaseLeafIds(
    state.sshRemotePtyLeases ?? [],
    normalizedSession.leafIdByInputLeafIdByTabId,
    normalizedSession.leafIdByPtyIdByTabId
  )
  const mergedMigrationUnsupportedEntries: MigrationUnsupportedPtyEntry[] = []
  const mergedLegacyPaneKeyAliasEntries = mergeLegacyPaneKeyAliasEntries([
    ...normalizeLegacyPaneKeyAliasEntries(state.legacyPaneKeyAliasEntries),
    ...legacyMigrationUnsupportedRowsToAliasEntries(state.migrationUnsupportedPtyEntries ?? []),
    ...normalizedSession.legacyPaneKeyAliasEntries
  ])
  const remappedAcknowledgements = remapAcknowledgedAgentPaneKeys(
    state.ui?.acknowledgedAgentsByPaneKey,
    normalizedSession.leafIdByInputLeafIdByTabId
  )
  const migrationUnsupportedChanged = !migrationUnsupportedEntriesEqual(
    state.migrationUnsupportedPtyEntries ?? [],
    mergedMigrationUnsupportedEntries
  )
  const legacyAliasesChanged = !legacyPaneKeyAliasEntriesEqual(
    state.legacyPaneKeyAliasEntries ?? [],
    mergedLegacyPaneKeyAliasEntries
  )
  if (
    !normalizedSession.changed &&
    !remappedLeases.changed &&
    !migrationUnsupportedChanged &&
    !legacyAliasesChanged &&
    !remappedAcknowledgements.changed
  ) {
    return {
      state,
      changed: false,
      migrationUnsupportedEntries: mergedMigrationUnsupportedEntries,
      legacyPaneKeyAliasEntries: mergedLegacyPaneKeyAliasEntries
    }
  }
  return {
    state: {
      ...state,
      workspaceSession: normalizedSession.session,
      sshRemotePtyLeases: remappedLeases.leases,
      migrationUnsupportedPtyEntries: mergedMigrationUnsupportedEntries,
      legacyPaneKeyAliasEntries: mergedLegacyPaneKeyAliasEntries,
      ...(remappedAcknowledgements.changed
        ? {
            ui: {
              ...state.ui,
              acknowledgedAgentsByPaneKey: remappedAcknowledgements.acknowledgements
            }
          }
        : {})
    },
    changed: true,
    migrationUnsupportedEntries: mergedMigrationUnsupportedEntries,
    legacyPaneKeyAliasEntries: mergedLegacyPaneKeyAliasEntries
  }
}

function remapAcknowledgedAgentPaneKeys(
  acknowledgements: PersistedState['ui']['acknowledgedAgentsByPaneKey'],
  leafIdByInputLeafIdByTabId: Map<string, Map<string, string>>
): { acknowledgements: PersistedState['ui']['acknowledgedAgentsByPaneKey']; changed: boolean } {
  if (!acknowledgements || Object.keys(acknowledgements).length === 0) {
    return { acknowledgements, changed: false }
  }

  let changed = false
  const next: NonNullable<PersistedState['ui']['acknowledgedAgentsByPaneKey']> = {}
  const setAcknowledgement = (paneKey: string, acknowledgedAt: number): void => {
    const existing = next[paneKey]
    next[paneKey] = existing === undefined ? acknowledgedAt : Math.max(existing, acknowledgedAt)
  }
  for (const [paneKey, acknowledgedAt] of Object.entries(acknowledgements)) {
    const parsed = parsePaneKey(paneKey)
    if (parsed) {
      setAcknowledgement(paneKey, acknowledgedAt)
      continue
    }

    const delimiter = paneKey.indexOf(':')
    if (delimiter <= 0 || delimiter === paneKey.length - 1) {
      setAcknowledgement(paneKey, acknowledgedAt)
      continue
    }

    const tabId = paneKey.slice(0, delimiter)
    const legacyLeafId = paneKey.slice(delimiter + 1)
    const remappedLeafId = leafIdByInputLeafIdByTabId.get(tabId)?.get(legacyLeafId)
    if (!remappedLeafId || !isTerminalLeafId(remappedLeafId)) {
      setAcknowledgement(paneKey, acknowledgedAt)
      continue
    }

    try {
      // Why: UI acks are keyed by paneKey just like hook rows. When a legacy
      // numeric/pane:* leaf is promoted to a UUID, carry the read marker over
      // so already-seen Activity/sidebar rows do not come back unread.
      setAcknowledgement(makePaneKey(tabId, remappedLeafId), acknowledgedAt)
      changed = true
    } catch {
      setAcknowledgement(paneKey, acknowledgedAt)
    }
  }

  return { acknowledgements: next, changed }
}

function normalizeMigrationUnsupportedPtyEntries(value: unknown): MigrationUnsupportedPtyEntry[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((entry): entry is MigrationUnsupportedPtyEntry => {
    if (!entry || typeof entry !== 'object') {
      return false
    }
    const candidate = entry as Partial<MigrationUnsupportedPtyEntry>
    return (
      typeof candidate.ptyId === 'string' &&
      candidate.ptyId.length > 0 &&
      (candidate.worktreeId === undefined || typeof candidate.worktreeId === 'string') &&
      (candidate.tabId === undefined || typeof candidate.tabId === 'string') &&
      (candidate.leafId === undefined || isTerminalLeafId(candidate.leafId)) &&
      (candidate.paneKey === undefined || typeof candidate.paneKey === 'string') &&
      candidate.reason === 'legacy-numeric-pane-key' &&
      (candidate.source === 'local' || candidate.source === 'ssh') &&
      Number.isFinite(candidate.updatedAt)
    )
  })
}

function normalizeLegacyPaneKeyAliasEntries(value: unknown): LegacyPaneKeyAliasEntry[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((entry): entry is LegacyPaneKeyAliasEntry => {
    if (!entry || typeof entry !== 'object') {
      return false
    }
    const candidate = entry as Partial<LegacyPaneKeyAliasEntry>
    if (
      typeof candidate.ptyId !== 'string' ||
      candidate.ptyId.trim().length === 0 ||
      typeof candidate.legacyPaneKey !== 'string' ||
      typeof candidate.stablePaneKey !== 'string' ||
      !Number.isFinite(candidate.updatedAt)
    ) {
      return false
    }
    const legacy = parseLegacyNumericPaneKey(candidate.legacyPaneKey)
    const stable = parsePaneKey(candidate.stablePaneKey)
    return Boolean(legacy && stable && legacy.tabId === stable.tabId)
  })
}

function mergeLegacyPaneKeyAliasEntries(
  entries: LegacyPaneKeyAliasEntry[]
): LegacyPaneKeyAliasEntry[] {
  const byLegacyPaneKey = new Map<string, LegacyPaneKeyAliasEntry>()
  for (const entry of normalizeLegacyPaneKeyAliasEntries(entries)) {
    const existing = byLegacyPaneKey.get(entry.legacyPaneKey)
    if (!existing || existing.updatedAt <= entry.updatedAt) {
      byLegacyPaneKey.set(entry.legacyPaneKey, entry)
    }
  }
  return [...byLegacyPaneKey.values()]
}

function legacyPaneKeyAliasEntriesEqual(
  left: LegacyPaneKeyAliasEntry[],
  right: LegacyPaneKeyAliasEntry[]
): boolean {
  if (left.length !== right.length) {
    return false
  }
  const rightByLegacyPaneKey = new Map(right.map((entry) => [entry.legacyPaneKey, entry]))
  return left.every((entry) => {
    const other = rightByLegacyPaneKey.get(entry.legacyPaneKey)
    return other ? JSON.stringify(entry) === JSON.stringify(other) : false
  })
}

function migrationUnsupportedEntriesEqual(
  left: MigrationUnsupportedPtyEntry[],
  right: MigrationUnsupportedPtyEntry[]
): boolean {
  if (left.length !== right.length) {
    return false
  }
  const rightByPtyId = new Map(right.map((entry) => [entry.ptyId, entry]))
  return left.every((entry) => {
    const other = rightByPtyId.get(entry.ptyId)
    return other ? JSON.stringify(entry) === JSON.stringify(other) : false
  })
}

function projectHostSetupCompatibilityStateEqual(
  state: Pick<PersistedState, 'projects' | 'projectHostSetups'>,
  nextState: Pick<PersistedState, 'projects' | 'projectHostSetups'>
): boolean {
  return (
    JSON.stringify(state.projects ?? []) === JSON.stringify(nextState.projects) &&
    JSON.stringify(state.projectHostSetups ?? []) === JSON.stringify(nextState.projectHostSetups)
  )
}

function isRepoBackedProjectHostSetup(
  setup: ProjectHostSetup,
  currentRepoIds: ReadonlySet<string>
): boolean {
  const repoId = typeof setup.repoId === 'string' ? setup.repoId : ''
  return repoId.length > 0 && (currentRepoIds.has(repoId) || setup.id === repoId)
}

function mergeProjectHostSetupCompatibilityState(
  state: Pick<PersistedState, 'projects' | 'projectHostSetups'>,
  repos: readonly Repo[]
): Pick<PersistedState, 'projects' | 'projectHostSetups'> {
  const projection = projectHostSetupProjectionFromRepos(repos)
  const existingProjectsById = new Map(
    (state.projects ?? []).map((project) => [project.id, project])
  )
  const currentRepoIds = new Set(repos.map((repo) => repo.id))
  const projectedProjectIds = new Set(projection.projects.map((project) => project.id))
  const projectedSetupIds = new Set(projection.setups.map((setup) => setup.id))
  // Why: legacy/repo-backed setup rows use the repo id as the setup id. Keep
  // only independent setup rows here so repo deletion does not leave ghosts.
  const independentSetups = (state.projectHostSetups ?? []).filter((setup) => {
    if (projectedSetupIds.has(setup.id)) {
      return false
    }
    return !isRepoBackedProjectHostSetup(setup, currentRepoIds)
  })
  const independentProjectIds = new Set(independentSetups.map((setup) => setup.projectId))
  const independentProjects = (state.projects ?? [])
    .filter(
      (project) => independentProjectIds.has(project.id) && !projectedProjectIds.has(project.id)
    )
    .map((project) => ({
      ...project,
      sourceRepoIds: project.sourceRepoIds.filter((repoId) => currentRepoIds.has(repoId))
    }))
  const projectedProjects = projection.projects.map((project) => {
    const existingProject = existingProjectsById.get(project.id)
    return existingProject?.localWindowsRuntimePreference
      ? {
          ...project,
          localWindowsRuntimePreference: existingProject.localWindowsRuntimePreference,
          updatedAt: Math.max(project.updatedAt, existingProject.updatedAt)
        }
      : project
  })
  return {
    projects: [...projectedProjects, ...independentProjects],
    projectHostSetups: [...projection.setups, ...independentSetups]
  }
}

function makeProjectHostSetupId(
  projectId: string,
  hostId: ExecutionHostId,
  existingIds: ReadonlySet<string>,
  requestedId?: string
): string {
  const baseId = requestedId?.trim() || `${projectId}::${hostId}`
  if (!existingIds.has(baseId)) {
    return baseId
  }
  let suffix = 2
  let candidate = `${baseId}::${suffix}`
  while (existingIds.has(candidate)) {
    suffix++
    candidate = `${baseId}::${suffix}`
  }
  return candidate
}

function createMinimalPersistedTerminalTab(args: {
  worktreeId: string
  tabId: string
  ptyId: string
  existingTabCount: number
}): TerminalTab {
  const ordinal = args.existingTabCount + 1
  const defaultTitle = `Terminal ${ordinal}`
  return {
    id: args.tabId,
    ptyId: args.ptyId,
    worktreeId: args.worktreeId,
    title: defaultTitle,
    defaultTitle,
    customTitle: null,
    color: null,
    sortOrder: args.existingTabCount,
    createdAt: Date.now(),
    pendingActivationSpawn: true
  }
}

function cloneWorkspaceSessionState(session: WorkspaceSessionState): WorkspaceSessionState {
  return structuredClone(session)
}

function removeWorkspaceSessionOwner(
  session: WorkspaceSessionState | undefined,
  ownerKey: string
): WorkspaceSessionState | undefined {
  if (!session) {
    return session
  }
  const next = cloneWorkspaceSessionState(session)
  const removedTerminalTabs = next.tabsByWorktree?.[ownerKey] ?? []
  if (next.tabsByWorktree) {
    delete next.tabsByWorktree[ownerKey]
  }
  for (const tab of removedTerminalTabs) {
    delete next.terminalLayoutsByTabId[tab.id]
    if (next.activeTabId === tab.id) {
      next.activeTabId = null
    }
  }

  if (next.openFilesByWorktree) {
    delete next.openFilesByWorktree[ownerKey]
  }
  if (next.activeFileIdByWorktree) {
    delete next.activeFileIdByWorktree[ownerKey]
  }
  const browserWorkspaces = next.browserTabsByWorktree?.[ownerKey] ?? []
  if (next.browserTabsByWorktree) {
    delete next.browserTabsByWorktree[ownerKey]
  }
  if (next.browserPagesByWorkspace) {
    for (const workspace of browserWorkspaces) {
      delete next.browserPagesByWorkspace[workspace.id]
    }
  }
  if (next.activeBrowserTabIdByWorktree) {
    delete next.activeBrowserTabIdByWorktree[ownerKey]
  }
  if (next.activeTabTypeByWorktree) {
    delete next.activeTabTypeByWorktree[ownerKey]
  }
  if (next.activeTabIdByWorktree) {
    delete next.activeTabIdByWorktree[ownerKey]
  }
  if (next.unifiedTabs) {
    delete next.unifiedTabs[ownerKey]
  }
  if (next.tabGroups) {
    delete next.tabGroups[ownerKey]
  }
  if (next.tabGroupLayouts) {
    delete next.tabGroupLayouts[ownerKey]
  }
  if (next.activeGroupIdByWorktree) {
    delete next.activeGroupIdByWorktree[ownerKey]
  }
  if (next.lastVisitedAtByWorktreeId) {
    delete next.lastVisitedAtByWorktreeId[ownerKey]
  }
  if (next.defaultTerminalTabsAppliedByWorktreeId) {
    delete next.defaultTerminalTabsAppliedByWorktreeId[ownerKey]
  }
  if (next.sleepingAgentSessionsByPaneKey) {
    for (const [paneKey, record] of Object.entries(next.sleepingAgentSessionsByPaneKey)) {
      if (record.worktreeId === ownerKey) {
        delete next.sleepingAgentSessionsByPaneKey[paneKey]
      }
    }
  }
  if (next.activeWorkspaceKey === ownerKey) {
    next.activeWorkspaceKey = null
  }
  if (next.activeWorktreeId === ownerKey) {
    next.activeWorktreeId = null
  }
  next.activeWorktreeIdsOnShutdown = next.activeWorktreeIdsOnShutdown?.filter(
    (worktreeId) => worktreeId !== ownerKey
  )
  return next
}

function inferFolderScopeConnectionIdForMigration(args: {
  folderPath: string
  projectGroupId: string
  projectGroups: readonly ProjectGroup[]
  repos: readonly Repo[]
}): string | null {
  const groupIds = getProjectGroupSubtreeIds(args.projectGroups, args.projectGroupId)
  const groupRepos = args.repos.filter(
    (repo) => typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)
  )
  const candidateRepos =
    groupRepos.length > 0
      ? groupRepos
      : args.repos.filter((repo) => isPathInsideOrEqual(args.folderPath, repo.path))
  if (candidateRepos.length === 0) {
    return null
  }
  let hasLocalRepo = false
  const connectionIds = new Set<string>()
  for (const repo of candidateRepos) {
    if (repo.connectionId) {
      connectionIds.add(repo.connectionId)
    } else {
      hasLocalRepo = true
    }
  }
  if (hasLocalRepo || connectionIds.size !== 1) {
    return null
  }
  return [...connectionIds][0]
}

function backfillFolderScopeConnectionIds(state: PersistedState): {
  state: PersistedState
  changed: boolean
} {
  const groups = state.projectGroups ?? []
  const repos = state.repos ?? []
  let changed = false
  const projectGroups = groups.map((group) => {
    if (group.connectionId || !group.parentPath) {
      return group
    }
    const connectionId = inferFolderScopeConnectionIdForMigration({
      folderPath: group.parentPath,
      projectGroupId: group.id,
      projectGroups: groups,
      repos
    })
    if (!connectionId) {
      return group
    }
    changed = true
    return { ...group, connectionId }
  })
  const groupsById = new Map(projectGroups.map((group) => [group.id, group]))
  const folderWorkspaces = (state.folderWorkspaces ?? []).map((workspace) => {
    if (workspace.connectionId) {
      return workspace
    }
    const groupConnectionId = groupsById.get(workspace.projectGroupId)?.connectionId ?? null
    const connectionId =
      groupConnectionId ??
      inferFolderScopeConnectionIdForMigration({
        folderPath: workspace.folderPath,
        projectGroupId: workspace.projectGroupId,
        projectGroups,
        repos
      })
    if (!connectionId) {
      return workspace
    }
    changed = true
    return { ...workspace, connectionId }
  })
  return {
    changed,
    state: changed ? { ...state, projectGroups, folderWorkspaces } : state
  }
}

function deleteRemovedTerminalScrollbackSnapshots(
  prior: WorkspaceSessionState | undefined,
  next: WorkspaceSessionState
): void {
  if (!prior) {
    return
  }
  const nextRefs = collectTerminalScrollbackSnapshotRefs(next)
  for (const ref of collectTerminalScrollbackSnapshotRefs(prior)) {
    if (!nextRefs.has(ref)) {
      deleteTerminalScrollbackSnapshotSync(ref)
    }
  }
}

export class Store {
  private state: PersistedState
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  private pendingWrite: Promise<void> | null = null
  private writeGeneration = 0
  // Why: hash of the plaintext state as of the last successful write. Saves
  // triggered by mutations that net out to identical state skip the full
  // 1.6MB pretty-print + tmp write + rename. Hashing plaintext (not the
  // written payload) because encrypt() uses a random IV per call, so the
  // on-disk bytes differ even for identical state.
  private lastWrittenStateHash: string | null = null
  private firstPendingSaveAt: number | null = null
  private gitUsernameCache = new Map<string, string>()
  private loadNeedsSave = false
  private settingsChangeListeners = new Set<
    (
      updates: Partial<GlobalSettings>,
      settings: GlobalSettings,
      originWebContentsId?: number
    ) => void
  >()
  private uiChangeListeners = new Set<(ui: PersistedState['ui']) => void>()

  constructor() {
    const loaded = this.load()
    const normalized = normalizePersistedPaneIdentityState(loaded)
    this.state = normalized.state
    const adaptedProjectGroups = this.adaptFlatFolderScanProjectGroups()
    for (const entry of normalized.migrationUnsupportedEntries) {
      setMigrationUnsupportedPty(entry)
    }
    for (const entry of normalized.legacyPaneKeyAliasEntries) {
      agentHookServer.registerPaneKeyAlias(
        entry.legacyPaneKey,
        entry.stablePaneKey,
        entry.ptyId,
        entry.updatedAt,
        { overwriteExisting: false }
      )
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
      // Why: upgraded sessions may contain legacy pane:1 leaves. Rewrite them at
      // the main persistence boundary so older renderer writes cannot revive them.
      // Other one-shot load migrations also set loadNeedsSave to persist their
      // guard flags before the next restart.
      this.scheduleSave()
    }
  }

  private adaptFlatFolderScanProjectGroups(): boolean {
    // Why: older folder imports persisted a real parent path but kept all repos
    // flat. Upgrade that shape into v1 sparse folder scopes on load.
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

  // Why (issue #1158): debounced writes fire as often as every 300ms during
  // active use. The backup ring should capture meaningfully different moments,
  // not five near-identical snapshots from one burst of store updates.
  private shouldRotateBackups(now: number, dataFile: string): boolean {
    try {
      const mtime = statSync(backupPath(dataFile, 0)).mtimeMs
      return now - mtime >= BACKUP_MIN_INTERVAL_MS
    } catch {
      return true
    }
  }

  // Why: rotate oldest to discarded and shift .bak.i to .bak.i+1 by rename;
  // then copy the current data file to .bak.0 so load() has a JSON recovery
  // source even if a later primary write is truncated or corrupted.
  private async rotateBackupsAsync(dataFile: string): Promise<void> {
    if (!existsSync(dataFile)) {
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
      if (existsSync(src)) {
        await rename(src, dst).catch((err) => {
          console.error('[persistence] Failed to rotate backup', src, '->', dst, err)
        })
      }
    }
    await copyFile(dataFile, backupPath(dataFile, 0)).catch((err) => {
      console.error('[persistence] Failed to snapshot current file to .bak.0:', err)
    })
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
    // Capture once, at the top: this is the unambiguous "has the user run
    // Orca before?" signal used by the telemetry cohort migration below.
    // Field-based inference (e.g., `settings.telemetry` presence) does not
    // work on the telemetry release itself — `telemetry` is new here, so it
    // would be absent on every pre-telemetry install and misclassify existing
    // users as fresh, flipping them to default-on in violation of the
    // social contract we installed them under.
    const dataFile = getDataFile()
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

        // Why: secret settings are stored encrypted on disk via safeStorage.
        // Decrypt at the load boundary so the rest of the app sees plaintext.
        if (parsed.settings?.opencodeSessionCookie) {
          parsed.settings.opencodeSessionCookie = decrypt(parsed.settings.opencodeSessionCookie)
        }
        if (parsed.settings?.httpProxyUrl) {
          parsed.settings.httpProxyUrl = decrypt(parsed.settings.httpProxyUrl)
        }
        if (parsed.ui?.browserKagiSessionLink) {
          parsed.ui.browserKagiSessionLink = decryptOptionalSecret(parsed.ui.browserKagiSessionLink)
        }

        // Merge with defaults in case new fields were added
        const homeDir = homedir()
        const defaults = getDefaultPersistedState(homeDir)
        const migratedTerminalScrollback = migrateTerminalScrollbackRows(parsed.settings)
        if (migratedTerminalScrollback.needsSave) {
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
        // Why: before the layout-aware 'auto' mode shipped (issue #903),
        // terminalMacOptionAsAlt defaulted to 'true' globally. That silently
        // broke Option-layer characters (@ on Turkish via Option+Q, @ on
        // German via Option+L, € on French via Option+E) for non-US users.
        // We can't distinguish a persisted 'true' that the user chose
        // explicitly from one they inherited from the old default — so on
        // first launch after upgrade, flip 'true' back to 'auto' and let
        // the renderer's keyboard-layout probe pick the right value per
        // layout. US users land on 'true' via detection (no change); non-US
        // users land on 'false' (correct). 'false'/'left'/'right' are
        // definitionally explicit choices (they never matched the old
        // default) so we carry those forward unchanged. The migrated flag
        // guards against re-running this on subsequent launches.
        const rawOptionAsAlt = parsed.settings?.terminalMacOptionAsAlt
        const alreadyMigrated = parsed.settings?.terminalMacOptionAsAltMigrated === true
        const migratedOptionAsAlt: 'auto' | 'true' | 'false' | 'left' | 'right' = alreadyMigrated
          ? (rawOptionAsAlt ?? 'auto')
          : rawOptionAsAlt === undefined || rawOptionAsAlt === 'true'
            ? 'auto'
            : rawOptionAsAlt
        const floatingTerminalDefaultedForAllUsers =
          parsed.settings?.floatingTerminalDefaultedForAllUsers === true
        // Why: early floating-terminal builds persisted the old off-by-default
        // value into user profiles. Flip only unmigrated profiles so a later
        // deliberate opt-out still survives reload.
        const migratedFloatingTerminalEnabled = floatingTerminalDefaultedForAllUsers
          ? (parsed.settings?.floatingTerminalEnabled ?? true)
          : true
        const floatingTerminalCwdMigrated =
          parsed.settings?.floatingTerminalCwdMigratedToAppWorkspace === true
        // Why: an earlier migration wrote '' for the default app-owned notes
        // directory. Floating terminals should still open at home by default;
        // markdown notes resolve their app-owned directory through a separate IPC.
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
            // Why: pre-grant profiles with an explicit Floating Workspace cwd
            // already represented user intent; migrate only that legacy value.
            migratedFloatingTerminalTrustedCwds.push(canonicalLegacyCwd)
            normalizedFloatingTerminalTrustedCwds.changed = true
          }
        }
        if (normalizedFloatingTerminalTrustedCwds.changed) {
          this.loadNeedsSave = true
        }
        const experimentalActivityDefaultedOffForAllUsers =
          parsed.settings?.experimentalActivityDefaultedOffForAllUsers === true
        // Why: the Agents view moved back behind Experimental. Flip every
        // pre-migration profile off once, then preserve future user opt-ins.
        const migratedExperimentalActivity = experimentalActivityDefaultedOffForAllUsers
          ? (parsed.settings?.experimentalActivity ?? false)
          : false
        const autoRenameBranchFromWorkDefaultedOn =
          parsed.settings?.autoRenameBranchFromWorkDefaultedOn === true
        // Why: default-on rollout should activate old profiles once, but a
        // later Settings opt-out must survive reloads.
        const migratedAutoRenameBranchFromWork = normalizeAutoRenameBranchFromWorkDefaultOn(
          parsed.settings
        )
        const migratedTerminalCursorStyle = normalizeTerminalCursorStyleDefault(parsed.settings)
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
        const defaultNewWorktreeCardStyle =
          shouldDefaultNewWorktreeCardStyleOn(normalizedOnboarding)
        const migratedExperimentalNewWorktreeCardStyle =
          parsed.settings?.experimentalNewWorktreeCardStyle ?? defaultNewWorktreeCardStyle
        if (
          parsed.settings?.experimentalNewWorktreeCardStyle === undefined &&
          defaultNewWorktreeCardStyle
        ) {
          this.loadNeedsSave = true
        }
        const normalizedProjectGroups = normalizeProjectGroups(parsed.projectGroups)
        const loadedCompactWorktreeCards =
          parsed.settings?.compactWorktreeCards ??
          parsed.settings?.experimentalCompactWorktreeCards ??
          defaults.settings.compactWorktreeCards
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
          folderWorkspaces: normalizeFolderWorkspaces(
            parsed.folderWorkspaces,
            normalizedProjectGroups
          ),
          worktreeLineageById: parsed.worktreeLineageById ?? {},
          workspaceLineageByChildKey: normalizeWorkspaceLineageByChildKey(
            parsed.workspaceLineageByChildKey
          ),
          settings: {
            ...defaults.settings,
            ...stripLegacyTerminalScrollbackBytes(parsed.settings),
            // Why: v1.3.42 renamed the cosmetic sidekick setting to pet. Carry
            // the old persisted flag forward once so enabled users don't lose it.
            experimentalPet:
              parsed.settings?.experimentalPet ?? readLegacySidekickFlag(parsed) ?? false,
            // Why: early primary-selection builds saved the disabled default.
            // Flip Linux/macOS profiles once so terminal-style defaults match
            // platform convention; the guards preserve future opt-outs.
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
            ...migratedTerminalTuiScrollSensitivity.settings,
            experimentalActivity: migratedExperimentalActivity,
            experimentalActivityDefaultedOffForAllUsers: true,
            // Why: open first-run onboarding is the local fresh-install signal;
            // closed/backfilled onboarding identifies existing profiles.
            experimentalNewWorktreeCardStyle: migratedExperimentalNewWorktreeCardStyle,
            // Why: compact worktree cards graduated from Experimental; preserve
            // the old opt-in for profiles written during the rollout.
            compactWorktreeCards: loadedCompactWorktreeCards,
            experimentalCompactWorktreeCards: undefined,
            terminalMacOptionAsAlt: migratedOptionAsAlt,
            terminalMacOptionAsAltMigrated: true,
            localWindowsRuntimeDefault: migratedWindowsRuntimeDefault,
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
            // Why: persisted settings can be user-edited or written by older
            // builds; keep tray-minimize false unless the stored value is true.
            minimizeToTrayOnClose: parsed.settings?.minimizeToTrayOnClose === true,
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
            notifications: normalizeNotificationSettings(parsed.settings?.notifications),
            sourceControlAi: migratedSourceControlAi,
            sourceControlGroupOrder: normalizedSourceControlGroupOrder,
            // Why: new builds read sourceControlAi, but rollback builds still
            // write commitMessageAi; after merging those writes, refresh the
            // legacy projection for continued rollback compatibility.
            commitMessageAi: projectSourceControlAiToLegacyCommitMessageAi(
              migratedSourceControlAi,
              parsed.settings?.commitMessageAi ?? defaults.settings.commitMessageAi
            ),
            voice: {
              ...getDefaultVoiceSettings(),
              ...parsed.settings?.voice
            }
          },
          // Why: 'recent' used to mean the weighted smart sort. One-shot
          // migration moves it to 'smart'; the flag prevents re-firing after
          // a user intentionally selects the new last-activity 'recent' sort.
          // Gate on the *raw* persisted value, not the normalized one: the
          // default sortBy is now 'recent', so a fresh install with no
          // persisted sortBy would otherwise be mis-migrated to 'smart'.
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
            // Why: a short-lived default put Done on the left. Repair only
            // the exact raw payload once; user-authored reorders then survive.
            const workspaceStatusesReorderedDefaultRepaired =
              parsed.ui?._workspaceStatusesReorderedDefaultRepaired === true
            // Why: only exact legacy default payloads are migrated; users who
            // customized status labels, colors, icons, or order keep theirs.
            const workspaceStatusesDefaultWorkflowMigrated =
              parsed.ui?._workspaceStatusesDefaultWorkflowMigrated === true
            // Why: visual migration has its own guard so later user choices
            // of valid legacy color/icon IDs are preserved by runtime writes.
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
                // Why: Linear used to be controlled by the generic issue
                // property and Ports were always visible. Add the split-out
                // properties once so existing cards keep their prior surface.
                if (candidate.includes('issue') && !candidate.includes('linear-issue')) {
                  next.push('linear-issue' as const)
                }
                if (!candidate.includes('ports')) {
                  next.push('ports' as const)
                }
                return next
              })()
              const normalized = normalizeWorktreeCardProperties(expandedCandidate)
              const changed =
                normalized.length !== rawCardProps.length ||
                normalized.some((property, index) => property !== rawCardProps[index])
              return changed ? normalized : undefined
            })()
            if (
              migratedCardProps !== undefined ||
              !inlineAgentsMigrated ||
              !expandedCardPropsMigrated
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
            return {
              ...defaults.ui,
              // Why: missing card properties should follow the persisted card
              // layout mode; explicit property choices are preserved below.
              worktreeCardProperties: getWorktreeCardModeProperties(
                loadedCompactWorktreeCards ? 'Compact' : 'Default'
              ),
              ...stripMainOwnedTelemetryMarkerFromUI(parsed.ui),
              // Why: migrate once from the retired Appearance setting only
              // when no explicit persisted chrome preference exists yet.
              rightSidebarOpen,
              rightSidebarTab: normalizeRightSidebarTab(parsed.ui?.rightSidebarTab),
              setupGuideSidebarDismissed,
              setupGuideBrowserMilestoneMigrated:
                typeof parsed.ui?.setupGuideBrowserMilestoneMigrated === 'boolean'
                  ? parsed.ui.setupGuideBrowserMilestoneMigrated
                  : false,
              setupGuideBrowserMilestoneLegacyComplete:
                parsed.ui?.setupGuideBrowserMilestoneLegacyComplete === true,
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
              // Why: keep stamping the legacy flag for forward-compat with
              // a rollback to a pre-default-on build that still reads it.
              // The new flag is the one that actually gates the migration.
              _inlineAgentsDefaultedForExperiment: true,
              _inlineAgentsDefaultedForAllUsers: true,
              _expandedWorktreeCardPropertiesDefaulted: true
            }
          })(),
          // Why: the workspace session is the most volatile persisted surface
          // (schema evolves per release, daemon session IDs embedded in it).
          // Zod-validate at the read boundary so a field-type flip from an
          // older build — or a truncated write from a crash — gets rejected
          // cleanly instead of poisoning Zustand state and crashing the
          // renderer on mount. On validation failure, fall back to defaults
          // and log; a corrupt session file shouldn't trap the user out.
          workspaceSession: (() => {
            if (parsed.workspaceSession === undefined) {
              return defaults.workspaceSession
            }
            const result = parseWorkspaceSession(parsed.workspaceSession)
            if (!result.ok) {
              console.error(
                '[persistence] Corrupt workspace session, using defaults:',
                result.error
              )
              return defaults.workspaceSession
            }
            return { ...defaults.workspaceSession, ...result.value }
          })(),
          // Why: per-host session partitions for non-'local' hosts. 'local'
          // stays in workspaceSession (legacy field) so a downgrade still
          // reads the user's workspace. Each entry is zod-validated the same
          // way as the legacy blob — a corrupt partition drops to that host's
          // defaults without poisoning the others.
          workspaceSessionsByHostId: parseWorkspaceSessionsByHostId(
            parsed.workspaceSessionsByHostId,
            defaults.workspaceSession
          ),
          sshTargets: (parsed.sshTargets ?? []).map(normalizeSshTarget),
          sshRemotePtyLeases: (parsed.sshRemotePtyLeases ?? [])
            .map(normalizeSshRemotePtyLease)
            .filter((lease): lease is SshRemotePtyLease => lease !== null),
          migrationUnsupportedPtyEntries: normalizeMigrationUnsupportedPtyEntries(
            parsed.migrationUnsupportedPtyEntries
          ),
          legacyPaneKeyAliasEntries: normalizeLegacyPaneKeyAliasEntries(
            parsed.legacyPaneKeyAliasEntries
          ),
          automations: Array.isArray(parsed.automations) ? parsed.automations : [],
          automationRuns: Array.isArray(parsed.automationRuns) ? parsed.automationRuns : [],
          onboarding: normalizedOnboarding
        }
      }
    } catch (err) {
      console.error('[persistence] Failed to load primary state, trying backups:', err)
    }

    // Corrupt-file catch path and "no file on disk" path converge here. The
    // telemetry migration below runs on whichever branch produced `result`,
    // because a user whose `orca-data.json` got corrupted is not a fresh
    // install of the telemetry release — they still count as existing and
    // must see the opt-in banner, not the default-on toast.
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
      const defaults = getDefaultPersistedState(homedir())
      const isFreshDefaultProfile =
        !fileExistedOnLoad && shouldDefaultNewWorktreeCardStyleOn(defaults.onboarding)
      result = {
        ...defaults,
        settings: {
          ...defaults.settings,
          // Why: a corrupt existing data file also falls back to defaults; only
          // the absent-file path is a true fresh install.
          experimentalNewWorktreeCardStyle: isFreshDefaultProfile
        }
      }
    }

    const workspaceSession = pruneWorkspaceSessionBrowserHistory(
      pruneLocalTerminalScrollbackBuffers(result.workspaceSession, result.repos)
    )
    const migratedScrollback = migrateWorkspaceSessionTerminalScrollbackSnapshots(workspaceSession)
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

    const migrated = this.migrateTelemetry(result, fileExistedOnLoad)
    logPersistenceStartupMilestone('persistence-load-done', {
      repos: migrated.repos.length,
      workspaceSessionBytes: Buffer.byteLength(JSON.stringify(migrated.workspaceSession))
    })
    return migrated
  }

  // One-shot telemetry cohort migration. Runs on every `load()` but is a
  // no-op once `existedBeforeTelemetryRelease` is set, so subsequent launches
  // pay only the property lookup. Populates:
  //   - `existedBeforeTelemetryRelease` — cohort discriminator (drives
  //     whether the existing-user opt-in banner is shown in PR 3;
  //     new users get no first-launch surface).
  //   - `optedIn` — new users start opted in; existing users are `null` until
  //     the banner resolves (the consent resolver returns `pending_banner`
  //     until then, so nothing transmits).
  //   - `installId` — anonymous UUID v4. Stable across launches; not surfaced in the UI.
  private migrateTelemetry(state: PersistedState, fileExistedOnLoad: boolean): PersistedState {
    const existing = state.settings?.telemetry
    // Why: the one-shot is complete only when all three invariants hold.
    // Keying on `existedBeforeTelemetryRelease` alone would let a partially-
    // written telemetry block (crash mid-save, hand-edit, future bug) short-
    // circuit migration and leave `installId` undefined or `optedIn` wiped.
    if (
      typeof existing?.existedBeforeTelemetryRelease === 'boolean' &&
      typeof existing.installId === 'string' &&
      existing.installId.length > 0 &&
      (existing.optedIn === true || existing.optedIn === false || existing.optedIn === null)
    ) {
      return state
    }
    // Why: cohort is the authoritative discriminator per invariant #8, so
    // resolve it once and reuse it below — the `optedIn` fallback must not
    // re-infer cohort from `fileExistedOnLoad` or field presence, or a
    // partially-written telemetry block could land a new user in the
    // existing-user `pending_banner` state.
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
          // Why: preserve an explicit opt-in/out if the user has ever resolved
          // it. Only fall back to the cohort default (new users: on; existing
          // users: undecided until the first-launch banner resolves) when
          // optedIn is truly unset (undefined), never when it is `false`.
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

  // Why 1s trailing + 5s max-wait (previously 300ms trailing, unbounded):
  // sustained sub-interval mutation bursts used to either rewrite the full
  // multi-MB state ~3x/sec or postpone the write indefinitely by resetting
  // the timer. The max-wait bounds crash staleness at 5s while bursts
  // coalesce; the content-hash guard in the writers skips no-op payloads.
  private static SAVE_DEBOUNCE_MS = 1_000
  private static SAVE_MAX_WAIT_MS = 5_000

  private scheduleSave(): void {
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
      // Why (issue #1158): serialize async writes so backup rotation never has
      // two callers racing over the same dataFile/tmp/.bak paths.
      const prev = this.pendingWrite ?? Promise.resolve()
      const next = prev
        .then(() => this.writeToDiskAsync())
        .catch((err) => {
          console.error('[persistence] Failed to write state:', err)
        })
        .finally(() => {
          if (this.pendingWrite === next) {
            this.pendingWrite = null
          }
        })
      this.pendingWrite = next
    }, delay)
  }

  /** Wait for any in-flight async disk write to complete. Used in tests. */
  async waitForPendingWrite(): Promise<void> {
    if (this.pendingWrite) {
      await this.pendingWrite
    }
  }

  private computeStateHash(): string {
    return createHash('sha1').update(JSON.stringify(this.state)).digest('hex')
  }

  // Why: builds the on-disk payload synchronously so the hash and the
  // serialized bytes reflect the same state tick (no mutation can interleave
  // before an await).
  private buildStateToSave(): string {
    // Why: secrets must be encrypted on disk. Clone state so the in-memory
    // this.state stays plaintext for the rest of the app.
    const stateToSave = {
      ...this.state,
      settings: {
        ...this.state.settings,
        opencodeSessionCookie: encrypt(this.state.settings.opencodeSessionCookie),
        httpProxyUrl: encrypt(this.state.settings.httpProxyUrl ?? '')
      },
      ui: {
        ...this.state.ui,
        browserKagiSessionLink: encryptOptionalSecret(this.state.ui.browserKagiSessionLink)
      }
    }
    return JSON.stringify(stateToSave, null, 2)
  }

  // Why: async writes avoid blocking the main Electron thread on every
  // debounced save during active use.
  private async writeToDiskAsync(): Promise<void> {
    const gen = this.writeGeneration
    const stateHash = this.computeStateHash()
    // Why: a mutation burst that nets out to already-persisted state (or a
    // flush that raced ahead) must not rewrite a byte-identical multi-MB file.
    if (stateHash === this.lastWrittenStateHash) {
      return
    }
    const payload = this.buildStateToSave()
    const dataFile = getDataFile()
    const dir = dirname(dataFile)
    await mkdir(dir, { recursive: true }).catch(() => {})
    const tmpFile = `${dataFile}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`

    // Why: wrap write+rename in try/finally-on-error so any failure (ENOSPC,
    // ENFILE, EIO, permission) removes the tmp file rather than leaving a
    // multi-megabyte orphan behind. Successful rename consumes the tmp file.
    let renamed = false
    try {
      await writeFile(tmpFile, payload, 'utf-8')
      // Why: if flush() ran while this async write was in-flight, it bumped
      // writeGeneration and already wrote the latest state synchronously.
      // Renaming this stale tmp file would overwrite the fresh data.
      if (this.writeGeneration !== gen) {
        return
      }
      await rename(tmpFile, dataFile)
      renamed = true
      // Why the gen re-check: a sync flush can interleave during the rename
      // await, write fresher state, and record its own hash. Recording this
      // stale hash over it would make later saves skip against content that
      // is not what the file holds.
      if (this.writeGeneration === gen) {
        this.lastWrittenStateHash = stateHash
      }
    } finally {
      if (!renamed) {
        await rm(tmpFile).catch(() => {})
      }
    }
    // Why (issue #1158): rotate only after the atomic rename succeeded; then
    // re-check the generation so a concurrent flush owns any backup rotation.
    if (this.writeGeneration !== gen) {
      return
    }
    const now = Date.now()
    if (this.shouldRotateBackups(now, dataFile)) {
      await this.rotateBackupsAsync(dataFile)
    }
  }

  // Why: synchronous variant kept only for flush() at shutdown, where the
  // process may exit before an async write completes.
  private writeToDiskSync(opts: { force?: boolean } = {}): void {
    const stateHash = this.computeStateHash()
    // Why: skipping is safe under flushOrThrow's durability contract — a
    // matching hash means this exact state is already the file's content.
    // Except when an async write was in flight at flush entry (force): its
    // rename may already be dispatched past the generation check, and only
    // an unconditional sync write afterwards reliably out-orders it.
    if (!opts.force && stateHash === this.lastWrittenStateHash) {
      return
    }
    const dataFile = getDataFile()
    const dir = dirname(dataFile)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    const tmpFile = `${dataFile}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`

    const payload = this.buildStateToSave()

    // Why: mirror the async path — on any failure between writeFileSync and
    // renameSync, remove the tmp file so crashes during shutdown don't leak
    // orphans into userData.
    let renamed = false
    try {
      writeFileSync(tmpFile, payload, 'utf-8')
      renameSync(tmpFile, dataFile)
      renamed = true
      this.lastWrittenStateHash = stateHash
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
    if (this.shouldRotateBackups(now, dataFile)) {
      this.rotateBackupsSync(dataFile)
    }
  }

  private flushOrThrow(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    this.firstPendingSaveAt = null
    const asyncWriteWasInFlight = this.pendingWrite !== null
    // Why: bump writeGeneration so any in-flight async writeToDiskAsync skips
    // its rename, preventing a stale snapshot from overwriting this sync write.
    this.writeGeneration++
    this.pendingWrite = null
    this.writeToDiskSync({ force: asyncWriteWasInFlight })
  }

  // ── Repos ──────────────────────────────────────────────────────────

  getRepos(): Repo[] {
    return this.state.repos.map((repo) => this.hydrateRepo(repo))
  }

  getProjects(): Project[] {
    return [...this.state.projects]
  }

  updateProject(id: string, updates: ProjectUpdateArgs['updates']): Project | null {
    const project = this.state.projects.find((entry) => entry.id === id)
    if (!project) {
      return null
    }
    if ('localWindowsRuntimePreference' in updates) {
      if (updates.localWindowsRuntimePreference === undefined) {
        delete project.localWindowsRuntimePreference
      } else {
        project.localWindowsRuntimePreference = normalizeProjectRuntimePreference(
          updates.localWindowsRuntimePreference
        )
      }
    }
    project.updatedAt = Date.now()
    this.scheduleSave()
    return { ...project }
  }

  getProjectHostSetups(): ProjectHostSetup[] {
    return [...this.state.projectHostSetups]
  }

  createProjectHostSetup(args: ProjectHostSetupCreateArgs): ProjectHostSetupCreateResult | null {
    const project = this.state.projects.find((entry) => entry.id === args.projectId)
    if (!project) {
      return null
    }
    const hostId = normalizeExecutionHostId(args.hostId)
    if (!hostId) {
      throw new Error(`Invalid host ID: ${args.hostId}`)
    }
    const duplicateSetup = this.state.projectHostSetups.find(
      (entry) => entry.projectId === project.id && entry.hostId === hostId
    )
    if (duplicateSetup) {
      throw new Error(`Project host setup already exists: ${duplicateSetup.id}`)
    }
    const now = Date.now()
    const existingIds = new Set(this.state.projectHostSetups.map((entry) => entry.id))
    const setup: ProjectHostSetup = {
      id: makeProjectHostSetupId(project.id, hostId, existingIds, args.setupId),
      projectId: project.id,
      hostId,
      repoId: '',
      path: args.path?.trim() ?? '',
      displayName: args.displayName?.trim() || project.displayName,
      ...(args.kind ? { kind: args.kind } : {}),
      ...(args.worktreeBasePath?.trim() ? { worktreeBasePath: args.worktreeBasePath.trim() } : {}),
      ...(args.gitUsername?.trim() ? { gitUsername: args.gitUsername.trim() } : {}),
      setupState: args.setupState ?? 'not-set-up',
      setupMethod: args.setupMethod ?? 'provisioned',
      createdAt: now,
      updatedAt: now
    }
    // Why: this is the first non-repo-backed setup creation path; it must
    // persist independently so future repo projection sync does not erase it.
    this.state.projectHostSetups.push(setup)
    this.scheduleSave()
    return { project, setup }
  }

  updateProjectHostSetup(args: ProjectHostSetupUpdateArgs): ProjectHostSetupUpdateResult | null {
    const setup = this.state.projectHostSetups.find((entry) => entry.id === args.setupId)
    if (!setup) {
      return null
    }
    const project = this.state.projects.find((entry) => entry.id === setup.projectId)
    if (!project) {
      return null
    }
    const repo = setup.repoId
      ? this.state.repos.find((entry) => entry.id === setup.repoId)
      : undefined
    if (repo) {
      const updated = this.updateRepoBackedProjectHostSetup(setup, repo, args.updates)
      const updatedProject = updated
        ? this.state.projects.find((entry) => entry.id === updated.setup.projectId)
        : undefined
      return updated && updatedProject
        ? { project: updatedProject, setup: updated.setup, repo: updated.repo }
        : null
    }
    const updatedSetup = this.updateIndependentProjectHostSetup(setup, args.updates)
    return { project, setup: updatedSetup }
  }

  deleteProjectHostSetup(args: ProjectHostSetupDeleteArgs): ProjectHostSetupDeleteResult | null {
    const setup = this.state.projectHostSetups.find((entry) => entry.id === args.setupId)
    if (!setup) {
      return null
    }
    const project = this.state.projects.find((entry) => entry.id === setup.projectId)
    if (!project) {
      return null
    }
    const repo = setup.repoId
      ? this.state.repos.find((entry) => entry.id === setup.repoId)
      : undefined
    if (repo) {
      this.removeProject(repo.id)
      return { project, setup, repo: this.hydrateRepo(repo) }
    }
    this.state.projectHostSetups = this.state.projectHostSetups.filter(
      (entry) => entry.id !== setup.id
    )
    this.scheduleSave()
    return { project, setup }
  }

  /**
   * O(1) read of the persisted repo count. Use this when you only need the
   * count (e.g. cohort-classifier) — `getRepos()` hydrates each repo and
   * may run a synchronous git subprocess via `getGitUsername()`, which is
   * wasteful when the caller only reads `.length`.
   */
  getRepoCount(): number {
    return this.state.repos.length
  }

  getRepo(id: string): Repo | undefined {
    const repo = this.state.repos.find((r) => r.id === id)
    return repo ? this.hydrateRepo(repo) : undefined
  }

  getProjectGroups(): ProjectGroup[] {
    return [...(this.state.projectGroups ?? [])].sort(
      (left, right) => left.tabOrder - right.tabOrder || left.name.localeCompare(right.name)
    )
  }

  createProjectGroup(input: {
    name: string
    parentPath?: string | null
    connectionId?: string | null
    parentGroupId?: string | null
    createdFrom: ProjectGroup['createdFrom']
  }): ProjectGroup {
    let maxOrder = -1
    // Why: persisted group lists can be large enough to exceed spread limits.
    for (const existingGroup of this.state.projectGroups ?? []) {
      maxOrder = Math.max(maxOrder, existingGroup.tabOrder)
    }
    const group = createProjectGroup({
      ...input,
      tabOrder: maxOrder + 1
    })
    this.state.projectGroups = [...(this.state.projectGroups ?? []), group]
    this.scheduleSave()
    return group
  }

  updateProjectGroup(
    groupId: string,
    updates: Partial<Pick<ProjectGroup, 'name' | 'isCollapsed' | 'tabOrder' | 'color'>>
  ): ProjectGroup | null {
    const group = (this.state.projectGroups ?? []).find((entry) => entry.id === groupId)
    if (!group) {
      return null
    }
    if (updates.name !== undefined) {
      group.name = normalizeProjectGroupName(updates.name, group.name)
    }
    if (updates.isCollapsed !== undefined) {
      group.isCollapsed = updates.isCollapsed
    }
    if (updates.tabOrder !== undefined && Number.isFinite(updates.tabOrder)) {
      group.tabOrder = updates.tabOrder
    }
    if (updates.color !== undefined) {
      group.color = typeof updates.color === 'string' ? updates.color : null
    }
    group.updatedAt = Date.now()
    this.scheduleSave()
    return group
  }

  deleteProjectGroup(groupId: string): boolean {
    const before = this.state.projectGroups?.length ?? 0
    const deletedGroupIds = getProjectGroupSubtreeIds(this.state.projectGroups ?? [], groupId)
    this.state.projectGroups = (this.state.projectGroups ?? []).filter(
      (group) => !deletedGroupIds.has(group.id)
    )
    if ((this.state.projectGroups?.length ?? 0) === before) {
      return false
    }
    // Why: groups are sidebar organization only. Deleting one must not delete
    // repos or worktrees, so contained repos from the full subtree are ungrouped.
    this.state.repos = this.state.repos.map((repo) =>
      repo.projectGroupId && deletedGroupIds.has(repo.projectGroupId)
        ? { ...repo, projectGroupId: null }
        : repo
    )
    for (const workspace of this.state.folderWorkspaces ?? []) {
      if (deletedGroupIds.has(workspace.projectGroupId)) {
        this.state.workspaceSession = removeWorkspaceSessionOwner(
          this.state.workspaceSession,
          folderWorkspaceKey(workspace.id)
        )!
        this.removeWorkspaceLineageForFolderParent(workspace.id)
      }
    }
    this.state.folderWorkspaces = (this.state.folderWorkspaces ?? []).filter(
      (workspace) => !deletedGroupIds.has(workspace.projectGroupId)
    )
    this.scheduleSave()
    return true
  }

  getFolderWorkspaces(): FolderWorkspace[] {
    return [...(this.state.folderWorkspaces ?? [])].sort(
      (left, right) => right.sortOrder - left.sortOrder || left.name.localeCompare(right.name)
    )
  }

  getFolderWorkspace(id: string): FolderWorkspace | undefined {
    return (this.state.folderWorkspaces ?? []).find((workspace) => workspace.id === id)
  }

  createFolderWorkspace(input: {
    projectGroupId: string
    name?: string
    folderPath?: string | null
    linkedTask?: FolderWorkspace['linkedTask']
    connectionId?: string | null
    createdWithAgent?: FolderWorkspace['createdWithAgent']
    pendingFirstAgentMessageRename?: boolean
  }): FolderWorkspace {
    const group = (this.state.projectGroups ?? []).find(
      (entry) => entry.id === input.projectGroupId
    )
    const folderPath =
      typeof input.folderPath === 'string' && input.folderPath.trim().length > 0
        ? input.folderPath
        : group?.parentPath
    if (!group || !folderPath) {
      throw new Error('Folder-backed project group not found.')
    }
    const now = Date.now()
    const workspace: FolderWorkspace = {
      id: randomUUID(),
      projectGroupId: group.id,
      name: normalizeFolderWorkspaceName(input.name, `${group.name} workspace`),
      folderPath,
      connectionId: input.connectionId ?? group.connectionId ?? null,
      linkedTask: input.linkedTask ?? null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: now,
      ...(input.createdWithAgent ? { createdWithAgent: input.createdWithAgent } : {}),
      ...(input.pendingFirstAgentMessageRename === true && input.createdWithAgent
        ? { pendingFirstAgentMessageRename: true }
        : {}),
      lastActivityAt: 0,
      createdAt: now,
      updatedAt: now
    }
    this.state.folderWorkspaces = [workspace, ...(this.state.folderWorkspaces ?? [])]
    this.scheduleSave()
    return workspace
  }

  updateFolderWorkspace(
    id: string,
    updates: Partial<
      Pick<
        FolderWorkspace,
        | 'name'
        | 'folderPath'
        | 'linkedTask'
        | 'comment'
        | 'isArchived'
        | 'isUnread'
        | 'isPinned'
        | 'sortOrder'
        | 'manualOrder'
        | 'workspaceStatus'
        | 'createdWithAgent'
        | 'pendingFirstAgentMessageRename'
        | 'firstAgentMessageRenameError'
        | 'lastActivityAt'
      >
    >
  ): FolderWorkspace | null {
    const workspace = this.getFolderWorkspace(id)
    if (!workspace) {
      return null
    }
    if (updates.name !== undefined) {
      workspace.name = normalizeFolderWorkspaceName(updates.name, workspace.name)
    }
    if (typeof updates.folderPath === 'string' && updates.folderPath.trim().length > 0) {
      workspace.folderPath = updates.folderPath
    }
    if (updates.linkedTask !== undefined) {
      workspace.linkedTask = updates.linkedTask
    }
    if (updates.comment !== undefined) {
      workspace.comment = updates.comment
    }
    if (updates.isArchived !== undefined) {
      workspace.isArchived = updates.isArchived
    }
    if (updates.isUnread !== undefined) {
      workspace.isUnread = updates.isUnread
    }
    if (updates.isPinned !== undefined) {
      workspace.isPinned = updates.isPinned
    }
    if (updates.sortOrder !== undefined && Number.isFinite(updates.sortOrder)) {
      workspace.sortOrder = updates.sortOrder
    }
    if (updates.manualOrder !== undefined) {
      if (Number.isFinite(updates.manualOrder)) {
        workspace.manualOrder = updates.manualOrder
      } else {
        delete workspace.manualOrder
      }
    }
    if (updates.workspaceStatus !== undefined) {
      workspace.workspaceStatus = updates.workspaceStatus
    }
    if (updates.createdWithAgent !== undefined) {
      workspace.createdWithAgent = updates.createdWithAgent
    }
    if (updates.pendingFirstAgentMessageRename !== undefined) {
      workspace.pendingFirstAgentMessageRename = updates.pendingFirstAgentMessageRename
    }
    if (updates.firstAgentMessageRenameError !== undefined) {
      workspace.firstAgentMessageRenameError = updates.firstAgentMessageRenameError
    }
    if (updates.lastActivityAt !== undefined && Number.isFinite(updates.lastActivityAt)) {
      workspace.lastActivityAt = updates.lastActivityAt
    }
    workspace.updatedAt = Date.now()
    this.scheduleSave()
    return workspace
  }

  removeFolderWorkspace(id: string): boolean {
    const before = this.state.folderWorkspaces?.length ?? 0
    this.state.folderWorkspaces = (this.state.folderWorkspaces ?? []).filter(
      (workspace) => workspace.id !== id
    )
    if ((this.state.folderWorkspaces?.length ?? 0) === before) {
      return false
    }
    this.state.workspaceSession = removeWorkspaceSessionOwner(
      this.state.workspaceSession,
      folderWorkspaceKey(id)
    )!
    this.removeWorkspaceLineageForFolderParent(id)
    this.scheduleSave()
    return true
  }

  moveProjectToGroup(repoId: string, groupId: string | null, order?: number): Repo | null {
    const repo = this.state.repos.find((entry) => entry.id === repoId)
    if (!repo) {
      return null
    }
    const normalizedGroupId =
      groupId && (this.state.projectGroups ?? []).some((group) => group.id === groupId)
        ? groupId
        : null
    const siblingRepos = this.state.repos.filter((entry) => entry.id !== repoId)
    repo.projectGroupId = normalizedGroupId
    repo.projectGroupOrder =
      typeof order === 'number' && Number.isFinite(order)
        ? order
        : getNextProjectGroupOrder(siblingRepos, normalizedGroupId)
    this.scheduleSave()
    return this.hydrateRepo(repo)
  }

  addRepo(repo: Repo): void {
    this.state.repos.push(repo)
    this.syncProjectHostSetupCompatibilityState()
    this.scheduleSave()
  }

  // Why: returns false on a stale permutation (concurrent add/remove races
  // the renderer's drag) so the caller can tell the renderer to resync rather
  // than persist an order that drops or duplicates ids.
  reorderRepos(orderedIds: string[]): boolean {
    const current = this.state.repos
    if (orderedIds.length !== current.length) {
      return false
    }
    const seen = new Set<string>()
    for (const id of orderedIds) {
      if (typeof id !== 'string' || seen.has(id)) {
        return false
      }
      seen.add(id)
    }
    const byId = new Map<string, Repo>()
    for (const r of current) {
      byId.set(r.id, r)
    }
    const next: Repo[] = []
    for (const id of orderedIds) {
      const repo = byId.get(id)
      if (!repo) {
        return false
      }
      next.push(repo)
    }
    this.state.repos = next
    this.syncProjectHostSetupCompatibilityState()
    this.scheduleSave()
    return true
  }

  removeProject(id: string): void {
    this.state.repos = this.state.repos.filter((r) => r.id !== id)
    this.syncProjectHostSetupCompatibilityState()
    // Why: presets are repo-scoped, so removing the repo means the presets
    // can never be referenced again — drop them with the parent.
    delete this.state.sparsePresetsByRepo[id]
    // Clean up worktree meta for this repo
    const prefix = `${id}::`
    for (const key of Object.keys(this.state.worktreeMeta)) {
      if (key.startsWith(prefix)) {
        delete this.state.worktreeMeta[key]
      }
    }
    for (const [childId, lineage] of Object.entries(this.state.worktreeLineageById)) {
      if (childId.startsWith(prefix) || lineage.parentWorktreeId.startsWith(prefix)) {
        delete this.state.worktreeLineageById[childId]
      }
    }
    for (const [childKey, lineage] of Object.entries(this.state.workspaceLineageByChildKey)) {
      const childScope = parseWorkspaceKey(childKey)
      const parentScope = parseWorkspaceKey(lineage.parentWorkspaceKey)
      if (childScope?.type === 'worktree' && childScope.worktreeId.startsWith(prefix)) {
        delete this.state.workspaceLineageByChildKey[childKey as WorkspaceKey]
        continue
      }
      if (parentScope?.type === 'worktree' && parentScope.worktreeId.startsWith(prefix)) {
        delete this.state.workspaceLineageByChildKey[childKey as WorkspaceKey]
      }
    }
    this.scheduleSave()
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
        | 'symlinkPaths'
        | 'issueSourcePreference'
        | 'forkSyncMode'
        | 'externalWorktreeVisibility'
        | 'externalWorktreeVisibilityPromptDismissedAt'
        | 'externalWorktreeInboxBaselinePaths'
        | 'importedExternalWorktreePaths'
        | 'projectGroupId'
        | 'projectGroupOrder'
        | 'projectHostSetupMethod'
      >
    > & {
      sourceControlAi?: Repo['sourceControlAi'] | null
      externalWorktreeDiscoverySuppressedAt?: Repo['externalWorktreeDiscoverySuppressedAt'] | null
    }
  ): Repo | null {
    const repo = this.state.repos.find((r) => r.id === id)
    if (!repo) {
      return null
    }
    const sanitizedUpdates = sanitizeRepoUpdatesForPersistence(updates)
    if ('projectGroupId' in sanitizedUpdates) {
      const nextGroupId = sanitizedUpdates.projectGroupId
      if (
        typeof nextGroupId !== 'string' ||
        nextGroupId.trim().length === 0 ||
        !this.state.projectGroups.some((group) => group.id === nextGroupId)
      ) {
        sanitizedUpdates.projectGroupId = null
      }
    }
    if (
      'projectGroupOrder' in sanitizedUpdates &&
      (typeof sanitizedUpdates.projectGroupOrder !== 'number' ||
        !Number.isFinite(sanitizedUpdates.projectGroupOrder))
    ) {
      delete sanitizedUpdates.projectGroupOrder
    }
    const externalWorktreeVisibilityLegacy =
      'externalWorktreeVisibility' in sanitizedUpdates &&
      repo.externalWorktreeVisibilityLegacy === undefined
        ? isLegacyRepoForExternalWorktreeVisibility(repo)
        : undefined
    // Why: selected repo fields use `undefined` as an explicit clear signal,
    // so delete them before assigning the rest of the patch.
    if (
      'issueSourcePreference' in sanitizedUpdates &&
      sanitizedUpdates.issueSourcePreference === undefined
    ) {
      delete repo.issueSourcePreference
      delete sanitizedUpdates.issueSourcePreference
    }
    if ('worktreeBasePath' in sanitizedUpdates && sanitizedUpdates.worktreeBasePath === undefined) {
      delete repo.worktreeBasePath
      delete sanitizedUpdates.worktreeBasePath
    }
    if (
      'externalWorktreeVisibility' in sanitizedUpdates &&
      repo.externalWorktreeVisibilityLegacy === undefined
    ) {
      // Why: old persisted repos have no explicit marker. Stamp it the first
      // time visibility changes so later hide/show choices keep legacy safety.
      repo.externalWorktreeVisibilityLegacy = externalWorktreeVisibilityLegacy
    }
    if (
      'externalWorktreeDiscoverySuppressedAt' in sanitizedUpdates &&
      (sanitizedUpdates.externalWorktreeDiscoverySuppressedAt === undefined ||
        sanitizedUpdates.externalWorktreeDiscoverySuppressedAt === null)
    ) {
      delete repo.externalWorktreeDiscoverySuppressedAt
      delete sanitizedUpdates.externalWorktreeDiscoverySuppressedAt
    }
    if (
      'sourceControlAi' in sanitizedUpdates &&
      (sanitizedUpdates.sourceControlAi === undefined || sanitizedUpdates.sourceControlAi === null)
    ) {
      delete repo.sourceControlAi
      delete sanitizedUpdates.sourceControlAi
    } else if ('sourceControlAi' in sanitizedUpdates) {
      const normalizedSourceControlAi = normalizeRepoSourceControlAiOverrides(
        sanitizedUpdates.sourceControlAi
      )
      if (normalizedSourceControlAi === undefined) {
        delete sanitizedUpdates.sourceControlAi
      } else {
        sanitizedUpdates.sourceControlAi = normalizedSourceControlAi
      }
    }
    Object.assign(repo, sanitizedUpdates)
    this.syncProjectHostSetupCompatibilityState()
    this.scheduleSave()
    return this.hydrateRepo(repo)
  }

  private syncProjectHostSetupCompatibilityState(): void {
    const compatibilityState = mergeProjectHostSetupCompatibilityState(this.state, this.state.repos)
    this.state.projects = compatibilityState.projects
    this.state.projectHostSetups = compatibilityState.projectHostSetups
  }

  private updateRepoBackedProjectHostSetup(
    setup: ProjectHostSetup,
    repo: Repo,
    updates: ProjectHostSetupUpdateArgs['updates']
  ): { setup: ProjectHostSetup; repo: Repo } | null {
    if (updates.path !== undefined && updates.path !== repo.path) {
      throw new Error(
        'Repo-backed project host setup paths must be changed by re-importing the project.'
      )
    }
    if (updates.setupState !== undefined && updates.setupState !== 'ready') {
      throw new Error('Repo-backed project host setups cannot be marked unavailable.')
    }
    const repoUpdates: Parameters<Store['updateRepo']>[1] = {}
    if (updates.displayName !== undefined) {
      repoUpdates.displayName = updates.displayName
    }
    if (updates.worktreeBasePath !== undefined) {
      repoUpdates.worktreeBasePath = updates.worktreeBasePath
    }
    if (updates.kind !== undefined) {
      repoUpdates.kind = updates.kind
    }
    if (updates.setupMethod === 'provisioned') {
      throw new Error('Repo-backed project host setups cannot be marked provisioned.')
    }
    if (updates.setupMethod !== undefined && updates.setupMethod !== 'legacy-repo') {
      repoUpdates.projectHostSetupMethod = updates.setupMethod
    }
    const updatedRepo =
      Object.keys(repoUpdates).length > 0 ? this.updateRepo(repo.id, repoUpdates) : repo
    if (!updatedRepo) {
      return null
    }
    return {
      setup: this.state.projectHostSetups.find((entry) => entry.id === setup.id) ?? setup,
      repo: updatedRepo
    }
  }

  private updateIndependentProjectHostSetup(
    setup: ProjectHostSetup,
    updates: ProjectHostSetupUpdateArgs['updates']
  ): ProjectHostSetup {
    if (updates.displayName !== undefined) {
      setup.displayName = updates.displayName.trim() || setup.displayName
    }
    if (updates.path !== undefined) {
      setup.path = updates.path.trim() || setup.path
    }
    if (updates.worktreeBasePath !== undefined) {
      const worktreeBasePath = updates.worktreeBasePath.trim()
      if (worktreeBasePath) {
        setup.worktreeBasePath = worktreeBasePath
      } else {
        delete setup.worktreeBasePath
      }
    }
    if (updates.kind !== undefined) {
      setup.kind = updates.kind
    }
    if (updates.gitUsername !== undefined) {
      const gitUsername = updates.gitUsername.trim()
      if (gitUsername) {
        setup.gitUsername = gitUsername
      } else {
        delete setup.gitUsername
      }
    }
    if (updates.setupState !== undefined) {
      setup.setupState = updates.setupState
    }
    if (updates.setupMethod !== undefined) {
      setup.setupMethod = updates.setupMethod
    }
    setup.updatedAt = Date.now()
    this.scheduleSave()
    return setup
  }

  private hydrateRepo(repo: Repo): Repo {
    const {
      repoIcon: rawRepoIcon,
      upstream: rawUpstream,
      gitRemoteIdentity: rawGitRemoteIdentity,
      sourceControlAi: rawSourceControlAi,
      projectHostSetupMethod: rawProjectHostSetupMethod,
      forkSyncMode: rawForkSyncMode,
      ...repoWithoutIcon
    } = repo
    const repoIcon = sanitizeRepoIcon(rawRepoIcon)
    const upstream = sanitizeRepoUpstream(rawUpstream)
    const gitRemoteIdentity = sanitizeGitRemoteIdentity(rawGitRemoteIdentity)
    const sourceControlAi = normalizeRepoSourceControlAiOverrides(rawSourceControlAi)
    const projectHostSetupMethod = sanitizeRepoProjectHostSetupMethod(rawProjectHostSetupMethod)
    const forkSyncMode = sanitizeForkSyncMode(rawForkSyncMode)
    const gitUsername = isFolderRepo(repo)
      ? ''
      : (this.gitUsernameCache.get(repo.path) ??
        (() => {
          const username = getGitUsername(repo.path)
          this.gitUsernameCache.set(repo.path, username)
          return username
        })())

    return {
      ...repoWithoutIcon,
      ...(repoIcon !== undefined ? { repoIcon } : {}),
      ...(upstream !== undefined ? { upstream } : {}),
      ...(gitRemoteIdentity !== undefined ? { gitRemoteIdentity } : {}),
      ...(sourceControlAi !== undefined ? { sourceControlAi } : {}),
      ...(projectHostSetupMethod !== undefined ? { projectHostSetupMethod } : {}),
      ...(forkSyncMode !== undefined ? { forkSyncMode } : {}),
      kind: isFolderRepo(repo) ? 'folder' : 'git',
      gitUsername,
      hookSettings: {
        ...getDefaultRepoHookSettings(),
        ...repo.hookSettings,
        scripts: {
          ...getDefaultRepoHookSettings().scripts,
          ...repo.hookSettings?.scripts
        }
      }
    }
  }

  // ── Sparse Presets ─────────────────────────────────────────────────

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

  listAutomations(): Automation[] {
    return (this.state.automations ?? [])
      .map((automation) => normalizeAutomationSessionReuse(automation))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  listAutomationRuns(automationId?: string): AutomationRun[] {
    const runs = this.state.automationRuns ?? []
    return [...(automationId ? runs.filter((run) => run.automationId === automationId) : runs)]
      .map((run) => ({
        ...run,
        precheckResult: normalizeAutomationPrecheckResult(run.precheckResult)
      }))
      .sort((left, right) => right.createdAt - left.createdAt)
  }

  createAutomation(input: AutomationCreateInput): Automation {
    const repo = this.state.repos.find((entry) => entry.id === input.projectId)
    const now = Date.now()
    const executionTargetType = repo?.connectionId ? 'ssh' : 'local'
    const schedulerOwner = getAutomationSchedulerOwner(repo)
    const contexts = getAutomationContextsForRepo(repo, this.state.projectHostSetups ?? [])
    const automation: Automation = {
      id: randomUUID(),
      name: input.name.trim() || 'Untitled automation',
      prompt: input.prompt,
      precheck: normalizeAutomationPrecheck(input.precheck),
      agentId: input.agentId,
      runContext: input.runContext ?? contexts.runContext,
      sourceContext: input.sourceContext ?? contexts.sourceContext,
      projectId: input.projectId,
      executionTargetType,
      executionTargetId: executionTargetType === 'ssh' ? (repo?.connectionId ?? '') : 'local',
      schedulerOwner,
      workspaceMode: input.workspaceMode,
      workspaceId: input.workspaceMode === 'existing' ? (input.workspaceId ?? null) : null,
      baseBranch: input.workspaceMode === 'new_per_run' ? (input.baseBranch ?? null) : null,
      setupDecision: normalizeAutomationSetupDecisionForWorkspaceMode(
        input.workspaceMode,
        input.setupDecision
      ),
      reuseSession: input.workspaceMode === 'existing' ? (input.reuseSession ?? false) : false,
      timezone: input.timezone,
      rrule: input.rrule,
      dtstart: input.dtstart,
      enabled: input.enabled ?? true,
      nextRunAt: nextAutomationOccurrenceAfter(input.rrule, input.dtstart, now),
      missedRunPolicy: 'run_once_within_grace',
      missedRunGraceMinutes: input.missedRunGraceMinutes ?? 720,
      createdAt: now,
      updatedAt: now
    }
    this.state.automations = [...(this.state.automations ?? []), automation]
    this.recordFeatureInteraction('automation-created')
    this.flush()
    return automation
  }

  updateAutomation(id: string, updates: AutomationUpdateInput): Automation {
    const index = (this.state.automations ?? []).findIndex((entry) => entry.id === id)
    if (index === -1) {
      throw new Error('Automation not found.')
    }
    const current = this.state.automations[index]
    const repoId = updates.projectId ?? current.projectId
    const repo = this.state.repos.find((entry) => entry.id === repoId)
    const executionTargetType = repo?.connectionId ? 'ssh' : 'local'
    const schedulerOwner = getAutomationSchedulerOwner(repo)
    const contexts = getAutomationContextsForRepo(repo, this.state.projectHostSetups ?? [])
    const rrule = updates.rrule ?? current.rrule
    const dtstart = updates.dtstart ?? current.dtstart
    const scheduleChanged = updates.rrule !== undefined || updates.dtstart !== undefined
    const workspaceMode = updates.workspaceMode ?? current.workspaceMode
    const updated: Automation = {
      ...current,
      ...updates,
      name:
        updates.name !== undefined ? updates.name.trim() || 'Untitled automation' : current.name,
      precheck: Object.hasOwn(updates, 'precheck')
        ? normalizeAutomationPrecheck(updates.precheck)
        : normalizeAutomationPrecheck(current.precheck),
      projectId: repoId,
      runContext: Object.hasOwn(updates, 'runContext')
        ? (updates.runContext ?? null)
        : updates.projectId !== undefined
          ? contexts.runContext
          : (current.runContext ?? contexts.runContext),
      sourceContext: Object.hasOwn(updates, 'sourceContext')
        ? (updates.sourceContext ?? null)
        : updates.projectId !== undefined
          ? contexts.sourceContext
          : (current.sourceContext ?? contexts.sourceContext),
      executionTargetType,
      executionTargetId: executionTargetType === 'ssh' ? (repo?.connectionId ?? '') : 'local',
      schedulerOwner,
      workspaceMode,
      workspaceId:
        workspaceMode === 'existing'
          ? Object.hasOwn(updates, 'workspaceId')
            ? (updates.workspaceId ?? null)
            : current.workspaceId
          : null,
      baseBranch:
        workspaceMode === 'new_per_run'
          ? Object.hasOwn(updates, 'baseBranch')
            ? (updates.baseBranch ?? null)
            : (current.baseBranch ?? null)
          : null,
      setupDecision:
        workspaceMode === 'new_per_run'
          ? Object.hasOwn(updates, 'setupDecision')
            ? normalizeAutomationSetupDecisionForWorkspaceMode(workspaceMode, updates.setupDecision)
            : normalizeAutomationSetupDecisionForWorkspaceMode(workspaceMode, current.setupDecision)
          : undefined,
      reuseSession:
        workspaceMode === 'existing'
          ? (updates.reuseSession ?? current.reuseSession ?? false)
          : false,
      rrule,
      dtstart,
      nextRunAt: scheduleChanged
        ? nextAutomationOccurrenceAfter(rrule, dtstart, Date.now())
        : current.nextRunAt,
      updatedAt: Date.now()
    }
    this.state.automations[index] = updated
    this.flush()
    return updated
  }

  deleteAutomation(id: string): void {
    this.state.automations = (this.state.automations ?? []).filter((entry) => entry.id !== id)
    this.state.automationRuns = (this.state.automationRuns ?? []).filter(
      (entry) => entry.automationId !== id
    )
    this.flush()
  }

  createAutomationRun(
    automation: Automation,
    scheduledFor: number,
    trigger: AutomationRunTrigger = 'scheduled'
  ): AutomationRun {
    const existing = (this.state.automationRuns ?? []).find(
      (run) => run.automationId === automation.id && run.scheduledFor === scheduledFor
    )
    if (existing) {
      return existing
    }
    const now = Date.now()
    const runNumber =
      (this.state.automationRuns ?? []).filter((run) => run.automationId === automation.id).length +
      1
    const run: AutomationRun = {
      id: randomUUID(),
      automationId: automation.id,
      runContext: automation.runContext ?? null,
      sourceContext: automation.sourceContext ?? null,
      title: `${automation.name} run ${runNumber}`,
      scheduledFor,
      status: 'pending',
      trigger,
      workspaceId: automation.workspaceId,
      workspaceDisplayName: this.getAutomationRunWorkspaceDisplayName(automation.workspaceId),
      sessionKind: 'terminal',
      chatSessionId: null,
      terminalSessionId: null,
      terminalPaneKey: null,
      terminalPtyId: null,
      outputSnapshot: null,
      precheckResult: null,
      usage: null,
      error: null,
      startedAt: null,
      dispatchedAt: null,
      createdAt: now
    }
    this.state.automationRuns = [...(this.state.automationRuns ?? []), run]
    if (trigger === 'manual') {
      this.recordFeatureInteraction('automation-run')
    }
    this.flush()
    return run
  }

  updateAutomationRun(result: AutomationDispatchResult): AutomationRun {
    const index = (this.state.automationRuns ?? []).findIndex((entry) => entry.id === result.runId)
    if (index === -1) {
      throw new Error('Automation run not found.')
    }
    const now = Date.now()
    const current = this.state.automationRuns[index]
    const workspaceId = result.workspaceId ?? current.workspaceId
    const workspaceDisplayName = Object.hasOwn(result, 'workspaceDisplayName')
      ? normalizeAutomationRunWorkspaceDisplayName(result.workspaceDisplayName ?? null)
      : null
    const updated: AutomationRun = {
      ...current,
      status: result.status,
      workspaceId,
      workspaceDisplayName:
        workspaceDisplayName ??
        normalizeAutomationRunWorkspaceDisplayName(current.workspaceDisplayName ?? null) ??
        this.getAutomationRunWorkspaceDisplayName(workspaceId),
      terminalSessionId: Object.hasOwn(result, 'terminalSessionId')
        ? (result.terminalSessionId ?? null)
        : current.terminalSessionId,
      terminalPaneKey: Object.hasOwn(result, 'terminalPaneKey')
        ? normalizeAutomationRunTerminalPaneKey(result.terminalPaneKey)
        : normalizeAutomationRunTerminalPaneKey(current.terminalPaneKey),
      terminalPtyId: Object.hasOwn(result, 'terminalPtyId')
        ? normalizeAutomationRunTerminalPtyId(result.terminalPtyId)
        : normalizeAutomationRunTerminalPtyId(current.terminalPtyId),
      outputSnapshot: Object.hasOwn(result, 'outputSnapshot')
        ? normalizeAutomationRunOutputSnapshot(result.outputSnapshot)
        : normalizeAutomationRunOutputSnapshot(current.outputSnapshot),
      precheckResult: Object.hasOwn(result, 'precheckResult')
        ? normalizeAutomationPrecheckResult(result.precheckResult)
        : normalizeAutomationPrecheckResult(current.precheckResult),
      usage: Object.hasOwn(result, 'usage') ? (result.usage ?? null) : (current.usage ?? null),
      error: result.error ?? null,
      startedAt: current.startedAt ?? now,
      dispatchedAt: result.status === 'dispatched' ? now : current.dispatchedAt
    }
    this.state.automationRuns[index] = updated
    const automation = this.state.automations.find((entry) => entry.id === updated.automationId)
    if (automation) {
      automation.lastRunAt = now
      automation.updatedAt = now
    }
    this.flush()
    return updated
  }

  snapshotAutomationRunWorkspaceDisplayName(workspaceId: string, displayName: string): number {
    const normalizedDisplayName = normalizeAutomationRunWorkspaceDisplayName(displayName)
    if (!normalizedDisplayName) {
      return 0
    }
    let updatedCount = 0
    this.state.automationRuns = (this.state.automationRuns ?? []).map((run) => {
      if (run.workspaceId !== workspaceId || run.workspaceDisplayName === normalizedDisplayName) {
        return run
      }
      updatedCount += 1
      return { ...run, workspaceDisplayName: normalizedDisplayName }
    })
    if (updatedCount > 0) {
      this.flush()
    }
    return updatedCount
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
    const index = (this.state.automations ?? []).findIndex((entry) => entry.id === id)
    if (index === -1) {
      throw new Error('Automation not found.')
    }
    const current = this.state.automations[index]
    const nextRunAt = nextAutomationOccurrenceAfter(current.rrule, current.dtstart, now)
    const updated = { ...current, nextRunAt, updatedAt: Date.now() }
    this.state.automations[index] = updated
    this.flush()
    return updated
  }

  getLatestAutomationOccurrence(automation: Automation, now = Date.now()): number | null {
    return latestAutomationOccurrenceAtOrBefore(automation.rrule, automation.dtstart, now)
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
    if (!updated.instanceId) {
      updated.instanceId = randomUUID()
    }
    this.state.worktreeMeta[worktreeId] = updated
    this.scheduleSave()
    return updated
  }

  removeWorktreeMeta(worktreeId: string): void {
    delete this.state.worktreeMeta[worktreeId]
    delete this.state.worktreeLineageById[worktreeId]
    delete this.state.workspaceLineageByChildKey[worktreeWorkspaceKey(worktreeId)]
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
   * Move every worktreeId-keyed record from `oldWorktreeId` to `newWorktreeId`
   * after the worktree's folder (and thus its `${repoId}::${path}` id) was
   * renamed on disk, so a post-move refresh re-binds the worktree's state under
   * the new id instead of orphaning it. Records the old id on the new meta's
   * `priorWorktreeIds` so the session GC/hydration can still recognize PTY
   * sessions minted under the old (path-derived) id. No-op when the ids match.
   *
   * Renderer counterpart: `buildWorktreeRenameState` in store/slices/worktrees.ts
   * re-keys the renderer's own worktree-scoped maps for the same id change.
   */
  migrateWorktreeIdentity(oldWorktreeId: string, newWorktreeId: string): void {
    if (oldWorktreeId === newWorktreeId) {
      return
    }
    const oldWorkspaceKey = worktreeWorkspaceKey(oldWorktreeId)
    const newWorkspaceKey = worktreeWorkspaceKey(newWorktreeId)
    const moveKey = <T>(
      record: Record<string, T>,
      mapValue: (value: T) => T = (value) => value
    ): boolean => {
      if (!(oldWorktreeId in record)) {
        return false
      }
      record[newWorktreeId] = mapValue(record[oldWorktreeId])
      delete record[oldWorktreeId]
      return true
    }
    const withNewWorktreeId = <T extends { worktreeId: string }>(value: T): T =>
      value.worktreeId === oldWorktreeId ? { ...value, worktreeId: newWorktreeId } : value
    const migrateSession = (session: WorkspaceSessionState | undefined): boolean => {
      if (!session) {
        return false
      }
      let sessionChanged = false
      const moveSessionKey = <T>(
        record: Record<string, T> | undefined,
        mapValue: (value: T) => T = (value) => value
      ): boolean => {
        if (!record) {
          return false
        }
        let moved = false
        const pairs: [string, string][] = [
          [oldWorktreeId, newWorktreeId],
          [oldWorkspaceKey, newWorkspaceKey]
        ]
        for (const [oldKey, newKey] of pairs) {
          if (!(oldKey in record)) {
            continue
          }
          record[newKey] = mapValue(record[oldKey])
          delete record[oldKey]
          moved = true
        }
        return moved
      }

      sessionChanged =
        moveSessionKey(session.tabsByWorktree, (tabs) => tabs.map(withNewWorktreeId)) ||
        sessionChanged
      sessionChanged =
        moveSessionKey(session.openFilesByWorktree, (files) => files.map(withNewWorktreeId)) ||
        sessionChanged
      sessionChanged = moveSessionKey(session.activeFileIdByWorktree) || sessionChanged
      sessionChanged =
        moveSessionKey(session.browserTabsByWorktree, (workspaces) =>
          workspaces.map(withNewWorktreeId)
        ) || sessionChanged
      if (session.browserPagesByWorkspace) {
        let pagesChanged = false
        const nextPagesByWorkspace = { ...session.browserPagesByWorkspace }
        for (const [workspaceId, pages] of Object.entries(nextPagesByWorkspace)) {
          if (!pages.some((page) => page.worktreeId === oldWorktreeId)) {
            continue
          }
          nextPagesByWorkspace[workspaceId] = pages.map(withNewWorktreeId)
          pagesChanged = true
        }
        if (pagesChanged) {
          session.browserPagesByWorkspace = nextPagesByWorkspace
          sessionChanged = true
        }
      }
      sessionChanged = moveSessionKey(session.activeBrowserTabIdByWorktree) || sessionChanged
      sessionChanged = moveSessionKey(session.activeTabTypeByWorktree) || sessionChanged
      sessionChanged = moveSessionKey(session.activeTabIdByWorktree) || sessionChanged
      sessionChanged =
        moveSessionKey(session.unifiedTabs, (tabs) => tabs.map(withNewWorktreeId)) || sessionChanged
      sessionChanged =
        moveSessionKey(session.tabGroups, (groups) => groups.map(withNewWorktreeId)) ||
        sessionChanged
      sessionChanged = moveSessionKey(session.tabGroupLayouts) || sessionChanged
      sessionChanged = moveSessionKey(session.activeGroupIdByWorktree) || sessionChanged
      sessionChanged = moveSessionKey(session.lastVisitedAtByWorktreeId) || sessionChanged
      sessionChanged =
        moveSessionKey(session.defaultTerminalTabsAppliedByWorktreeId) || sessionChanged
      if (session.activeWorktreeIdsOnShutdown?.includes(oldWorktreeId)) {
        session.activeWorktreeIdsOnShutdown = session.activeWorktreeIdsOnShutdown.map((id) =>
          id === oldWorktreeId ? newWorktreeId : id
        )
        sessionChanged = true
      }
      if (session.activeWorktreeId === oldWorktreeId) {
        session.activeWorktreeId = newWorktreeId
        sessionChanged = true
      }
      if (session.activeWorkspaceKey === oldWorkspaceKey) {
        session.activeWorkspaceKey = newWorkspaceKey
        sessionChanged = true
      }
      if (session.sleepingAgentSessionsByPaneKey) {
        let sleepingChanged = false
        const nextSleeping = { ...session.sleepingAgentSessionsByPaneKey }
        for (const [paneKey, record] of Object.entries(nextSleeping)) {
          if (record.worktreeId !== oldWorktreeId) {
            continue
          }
          nextSleeping[paneKey] = { ...record, worktreeId: newWorktreeId }
          sleepingChanged = true
        }
        if (sleepingChanged) {
          session.sleepingAgentSessionsByPaneKey = nextSleeping
          sessionChanged = true
        }
      }
      return sessionChanged
    }

    let changed = moveKey(this.state.worktreeMeta)
    // Record the prior id so a session minted under it isn't reaped as an orphan.
    const newMeta = this.state.worktreeMeta[newWorktreeId]
    if (newMeta) {
      const prior = newMeta.priorWorktreeIds ?? []
      if (!prior.includes(oldWorktreeId)) {
        newMeta.priorWorktreeIds = [...prior, oldWorktreeId]
        changed = true
      }
    }

    changed = moveKey(this.state.worktreeLineageById) || changed
    const movedLineage = this.state.worktreeLineageById[newWorktreeId]
    if (movedLineage && movedLineage.worktreeId === oldWorktreeId) {
      movedLineage.worktreeId = newWorktreeId
    }
    // Why: other worktrees created from this one carry it as parentWorktreeId;
    // the stable parentWorktreeInstanceId is unaffected, but keep the denormalized
    // path-derived id consistent too.
    for (const lineage of Object.values(this.state.worktreeLineageById)) {
      if (lineage.parentWorktreeId === oldWorktreeId) {
        lineage.parentWorktreeId = newWorktreeId
        changed = true
      }
    }

    if (oldWorkspaceKey in this.state.workspaceLineageByChildKey) {
      const lineage = this.state.workspaceLineageByChildKey[oldWorkspaceKey]
      this.state.workspaceLineageByChildKey[newWorkspaceKey] = {
        ...lineage,
        childWorkspaceKey: newWorkspaceKey
      }
      delete this.state.workspaceLineageByChildKey[oldWorkspaceKey]
      changed = true
    }
    for (const [childKey, lineage] of Object.entries(this.state.workspaceLineageByChildKey)) {
      if (lineage.parentWorkspaceKey === oldWorkspaceKey) {
        this.state.workspaceLineageByChildKey[childKey as WorkspaceKey] = {
          ...lineage,
          parentWorkspaceKey: newWorkspaceKey
        }
        changed = true
      }
    }

    changed = migrateSession(this.state.workspaceSession) || changed
    for (const session of Object.values(this.state.workspaceSessionsByHostId ?? {})) {
      changed = migrateSession(session) || changed
    }
    const showDotfiles = this.state.ui?.showDotfilesByWorktree
    if (showDotfiles) {
      changed = moveKey(showDotfiles) || changed
    }

    if (changed) {
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

  // Why: UI view-state (group/sort/filters etc.) is written from both the
  // desktop renderer and mobile (via the ui.set RPC) into one shared store.
  // Without this, a mobile change persisted but the desktop renderer — which
  // hydrates UI state once — never learned of it, breaking bi-directional sync.
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

  updateSettings(
    updates: Partial<GlobalSettings>,
    options: { notifyListeners?: boolean; originWebContentsId?: number } = {}
  ): GlobalSettings {
    const sanitizedUpdates = stripLegacyTerminalScrollbackBytes(updates)
    // Why: coerce strictly to boolean here (not at the IPC edge) so every write
    // path is covered and a non-bool renderer payload can never persist a
    // truthy non-bool that later reads as "tray-minimize on".
    if ('minimizeToTrayOnClose' in updates) {
      sanitizedUpdates.minimizeToTrayOnClose = updates.minimizeToTrayOnClose === true
    }
    if ('disabledTuiAgents' in updates) {
      sanitizedUpdates.disabledTuiAgents = normalizeDisabledTuiAgents(updates.disabledTuiAgents)
    }
    if ('agentDefaultArgs' in updates) {
      sanitizedUpdates.agentDefaultArgs = normalizeTuiAgentArgsRecord(updates.agentDefaultArgs)
      sanitizedUpdates.agentYoloDefaultsMigrated = true
    }
    if ('agentDefaultEnv' in updates) {
      sanitizedUpdates.agentDefaultEnv = normalizeTuiAgentEnvRecord(updates.agentDefaultEnv)
      sanitizedUpdates.agentYoloDefaultsMigrated = true
    }
    if ('terminalQuickCommands' in updates) {
      sanitizedUpdates.terminalQuickCommands = normalizeTerminalQuickCommands(
        updates.terminalQuickCommands
      )
    }
    if ('terminalCustomThemes' in updates) {
      sanitizedUpdates.terminalCustomThemes = normalizeTerminalCustomThemes(
        updates.terminalCustomThemes
      )
    }
    if ('terminalScrollbackRows' in updates) {
      sanitizedUpdates.terminalScrollbackRows = normalizeDesktopTerminalScrollbackRows(
        updates.terminalScrollbackRows
      )
    }
    if (
      'terminalTuiScrollSensitivity' in updates ||
      'terminalTuiScrollSensitivityDefaultedToOne' in updates
    ) {
      sanitizedUpdates.terminalTuiScrollSensitivityDefaultedToOne = true
    }
    if ('visibleTaskProviders' in updates || 'defaultTaskSource' in updates) {
      const taskProviderSettings = normalizeTaskProviderSettings({
        visibleTaskProviders:
          'visibleTaskProviders' in updates
            ? updates.visibleTaskProviders
            : this.state.settings.visibleTaskProviders,
        defaultTaskSource:
          'defaultTaskSource' in updates
            ? updates.defaultTaskSource
            : this.state.settings.defaultTaskSource
      })
      sanitizedUpdates.defaultTaskSource = taskProviderSettings.defaultTaskSource
      sanitizedUpdates.visibleTaskProviders = taskProviderSettings.visibleTaskProviders
      if ('visibleTaskProviders' in updates) {
        sanitizedUpdates.visibleTaskProvidersDefaultedForJira = true
      }
    }
    if ('autoRenameBranchFromWork' in updates || 'autoRenameBranchFromWorkDefaultedOn' in updates) {
      sanitizedUpdates.autoRenameBranchFromWorkDefaultedOn = true
    }
    if ('openInApplications' in updates) {
      sanitizedUpdates.openInApplications = normalizeOpenInApplications(updates.openInApplications)
    }
    if ('terminalShortcutPolicy' in updates) {
      sanitizedUpdates.terminalShortcutPolicy = normalizeTerminalShortcutPolicy(
        updates.terminalShortcutPolicy
      )
    }
    if ('sourceControlGroupOrder' in updates) {
      sanitizedUpdates.sourceControlGroupOrder = normalizeSourceControlGroupOrder(
        updates.sourceControlGroupOrder
      )
    }
    if ('appIcon' in updates) {
      sanitizedUpdates.appIcon = normalizeAppIconId(updates.appIcon)
    }
    if ('uiLanguage' in updates) {
      sanitizedUpdates.uiLanguage = normalizeUiLanguage(updates.uiLanguage)
    }
    const historyWithPreviousLayout = buildWorkspaceDirHistoryForUpdate(
      this.state.settings,
      sanitizedUpdates
    )
    if (historyWithPreviousLayout) {
      sanitizedUpdates.workspaceDirHistory = historyWithPreviousLayout
    }
    // Why: `telemetry` is deep-merged for the same reason `notifications` is —
    // partial updates from the Privacy pane / consent flow (e.g., flipping
    // only `optedIn`) must not clobber sibling fields like `installId` or
    // `existedBeforeTelemetryRelease`. The field is optional, so we only
    // synthesize a `telemetry` key on the result when at least one side has
    // one.
    const mergedTelemetry =
      sanitizedUpdates.telemetry !== undefined
        ? { ...this.state.settings.telemetry, ...sanitizedUpdates.telemetry }
        : this.state.settings.telemetry
    if ('sourceControlAi' in sanitizedUpdates) {
      sanitizedUpdates.sourceControlAi = retireLegacyInstructionsForClearedTextActionRecipes(
        sanitizedUpdates.sourceControlAi,
        this.state.settings
      )
      const normalizedSourceControlAi = normalizeSourceControlAiSettings(
        sanitizedUpdates.sourceControlAi,
        this.state.settings.commitMessageAi
      )
      sanitizedUpdates.sourceControlAi = normalizedSourceControlAi
      sanitizedUpdates.commitMessageAi = projectSourceControlAiToLegacyCommitMessageAi(
        normalizedSourceControlAi,
        this.state.settings.commitMessageAi
      )
    } else if ('commitMessageAi' in sanitizedUpdates) {
      sanitizedUpdates.sourceControlAi = mergeLegacyCommitMessageAiIntoSourceControlAi(
        this.state.settings.sourceControlAi,
        sanitizedUpdates.commitMessageAi
      )
    }
    const previousSettings = this.state.settings
    this.state.settings = {
      ...this.state.settings,
      ...sanitizedUpdates,
      notifications: normalizeNotificationSettings({
        ...this.state.settings.notifications,
        ...sanitizedUpdates.notifications
      }),
      ...(mergedTelemetry !== undefined ? { telemetry: mergedTelemetry } : {})
    }
    this.scheduleSave()
    const changedUpdates = {} as Partial<GlobalSettings> & Record<string, unknown>
    for (const key of Object.keys(sanitizedUpdates) as (keyof GlobalSettings)[]) {
      if (!Object.is(previousSettings[key], this.state.settings[key])) {
        changedUpdates[String(key)] = this.state.settings[key]
      }
    }
    if (options.notifyListeners === true && Object.keys(changedUpdates).length > 0) {
      this.notifySettingsChanged(changedUpdates, options.originWebContentsId)
    }
    return this.state.settings
  }

  // ── UI State ───────────────────────────────────────────────────────

  getUI(): PersistedState['ui'] {
    const uiState = stripMainOwnedTelemetryMarkerFromUI(this.state.ui)
    return {
      ...getDefaultUIState(),
      ...uiState,
      groupBy: normalizeGroupBy(this.state.ui?.groupBy),
      sortBy: normalizeSortBy(this.state.ui?.sortBy),
      projectOrderBy: normalizeProjectOrderBy(this.state.ui?.projectOrderBy),
      rightSidebarTab: normalizeRightSidebarTab(this.state.ui?.rightSidebarTab),
      rightSidebarExplorerView: normalizeRightSidebarExplorerView(
        this.state.ui?.rightSidebarExplorerView,
        this.state.ui?.rightSidebarTab
      ),
      worktreeCardProperties: normalizeWorktreeCardProperties(
        this.state.ui?.worktreeCardProperties
      ),
      agentActivityDisplayMode: normalizeAgentActivityDisplayMode(
        this.state.ui?.agentActivityDisplayMode
      ),
      workspaceStatuses: normalizeWorkspaceStatuses(this.state.ui?.workspaceStatuses),
      workspaceBoardOpacity: clampWorkspaceBoardOpacity(this.state.ui?.workspaceBoardOpacity),
      workspaceBoardColumnWidth: clampWorkspaceBoardColumnWidth(
        this.state.ui?.workspaceBoardColumnWidth
      ),
      syncTaskStatusFromWorkspaceBoard: this.state.ui?.syncTaskStatusFromWorkspaceBoard === true,
      // Why: strict boolean coercion so a missing/legacy value reads as false
      // (first-run notice still fires) rather than leaking a non-bool through.
      trayMinimizeNoticeShown: this.state.ui?.trayMinimizeNoticeShown === true,
      markdownTocPanelWidth: clampMarkdownTocPanelWidth(this.state.ui?.markdownTocPanelWidth),
      visibleWorkspaceHostIds: normalizeVisibleExecutionHostIds(
        this.state.ui?.visibleWorkspaceHostIds
      ),
      workspaceHostOrder: normalizeExecutionHostOrder(this.state.ui?.workspaceHostOrder),
      browserDefaultZoomLevel: normalizeBrowserPageZoomLevel(
        this.state.ui?.browserDefaultZoomLevel
      ),
      showDotfilesByWorktree: normalizeShowDotfilesByWorktree(
        this.state.ui?.showDotfilesByWorktree
      ),
      featureTipsSeenIds: normalizeFeatureTipIds(this.state.ui?.featureTipsSeenIds),
      contextualToursSeenIds: normalizeContextualTourIds(this.state.ui?.contextualToursSeenIds),
      featureInteractions: normalizeFeatureInteractions(this.state.ui?.featureInteractions)
    }
  }

  updateUI(updates: Partial<PersistedState['ui']>): void {
    const sanitizedUpdates = stripMainOwnedTelemetryMarkerFromUI(updates)
    const previousUI = this.getUI()
    const currentUI = {
      ...getDefaultUIState(),
      ...stripMainOwnedTelemetryMarkerFromUI(this.state.ui)
    }
    const nextRightSidebarTab =
      sanitizedUpdates.rightSidebarTab !== undefined
        ? normalizeRightSidebarTab(sanitizedUpdates.rightSidebarTab)
        : normalizeRightSidebarTab(this.state.ui?.rightSidebarTab)
    const nextRightSidebarExplorerView =
      sanitizedUpdates.rightSidebarExplorerView !== undefined
        ? normalizeRightSidebarExplorerView(
            sanitizedUpdates.rightSidebarExplorerView,
            nextRightSidebarTab
          )
        : sanitizedUpdates.rightSidebarTab === 'search'
          ? 'search'
          : normalizeRightSidebarExplorerView(
              this.state.ui?.rightSidebarExplorerView,
              nextRightSidebarTab
            )
    const nextUI = {
      ...currentUI,
      ...sanitizedUpdates,
      groupBy: sanitizedUpdates.groupBy
        ? normalizeGroupBy(sanitizedUpdates.groupBy)
        : normalizeGroupBy(this.state.ui?.groupBy),
      sortBy: sanitizedUpdates.sortBy
        ? normalizeSortBy(sanitizedUpdates.sortBy)
        : normalizeSortBy(this.state.ui?.sortBy),
      projectOrderBy: updates.projectOrderBy
        ? normalizeProjectOrderBy(updates.projectOrderBy)
        : normalizeProjectOrderBy(this.state.ui?.projectOrderBy),
      rightSidebarTab: nextRightSidebarTab,
      rightSidebarExplorerView: nextRightSidebarExplorerView,
      worktreeCardProperties:
        sanitizedUpdates.worktreeCardProperties !== undefined
          ? normalizeWorktreeCardProperties(sanitizedUpdates.worktreeCardProperties)
          : normalizeWorktreeCardProperties(this.state.ui?.worktreeCardProperties),
      agentActivityDisplayMode:
        updates.agentActivityDisplayMode !== undefined
          ? normalizeAgentActivityDisplayMode(updates.agentActivityDisplayMode)
          : normalizeAgentActivityDisplayMode(this.state.ui?.agentActivityDisplayMode),
      workspaceStatuses:
        sanitizedUpdates.workspaceStatuses !== undefined
          ? normalizeWorkspaceStatuses(sanitizedUpdates.workspaceStatuses)
          : normalizeWorkspaceStatuses(this.state.ui?.workspaceStatuses),
      workspaceBoardOpacity: clampWorkspaceBoardOpacity(
        sanitizedUpdates.workspaceBoardOpacity ?? this.state.ui?.workspaceBoardOpacity
      ),
      workspaceBoardColumnWidth: clampWorkspaceBoardColumnWidth(
        sanitizedUpdates.workspaceBoardColumnWidth ?? this.state.ui?.workspaceBoardColumnWidth
      ),
      syncTaskStatusFromWorkspaceBoard:
        sanitizedUpdates.syncTaskStatusFromWorkspaceBoard !== undefined
          ? sanitizedUpdates.syncTaskStatusFromWorkspaceBoard === true
          : this.state.ui?.syncTaskStatusFromWorkspaceBoard === true,
      markdownTocPanelWidth: clampMarkdownTocPanelWidth(
        sanitizedUpdates.markdownTocPanelWidth ?? this.state.ui?.markdownTocPanelWidth
      ),
      visibleWorkspaceHostIds:
        updates.visibleWorkspaceHostIds !== undefined
          ? normalizeVisibleExecutionHostIds(updates.visibleWorkspaceHostIds)
          : normalizeVisibleExecutionHostIds(this.state.ui?.visibleWorkspaceHostIds),
      workspaceHostOrder:
        updates.workspaceHostOrder !== undefined
          ? normalizeExecutionHostOrder(updates.workspaceHostOrder)
          : normalizeExecutionHostOrder(this.state.ui?.workspaceHostOrder),
      browserDefaultZoomLevel: normalizeBrowserPageZoomLevel(
        updates.browserDefaultZoomLevel ?? this.state.ui?.browserDefaultZoomLevel
      ),
      showDotfilesByWorktree:
        updates.showDotfilesByWorktree !== undefined
          ? normalizeShowDotfilesByWorktree(updates.showDotfilesByWorktree)
          : normalizeShowDotfilesByWorktree(this.state.ui?.showDotfilesByWorktree),
      featureTipsSeenIds:
        sanitizedUpdates.featureTipsSeenIds !== undefined
          ? normalizeFeatureTipIds(sanitizedUpdates.featureTipsSeenIds)
          : normalizeFeatureTipIds(this.state.ui?.featureTipsSeenIds),
      // Why: renderer and paired clients can mark different tours seen from
      // stale UI snapshots; union them so completed tours stay suppressed.
      contextualToursSeenIds:
        updates.contextualToursSeenIds !== undefined
          ? mergeContextualTourSeenIds(
              this.state.ui?.contextualToursSeenIds,
              updates.contextualToursSeenIds
            )
          : normalizeContextualTourIds(this.state.ui?.contextualToursSeenIds),
      // Why: runtime RPCs and the renderer can both record education state.
      // Merge instead of replacing so a stale renderer snapshot cannot erase
      // runtime-only feature interactions.
      featureInteractions:
        sanitizedUpdates.featureInteractions !== undefined
          ? mergeFeatureInteractions(
              this.state.ui?.featureInteractions,
              sanitizedUpdates.featureInteractions
            )
          : normalizeFeatureInteractions(this.state.ui?.featureInteractions)
    }
    if (persistedUIValuesEqual(previousUI, nextUI)) {
      return
    }
    this.state.ui = nextUI
    this.scheduleSave()
    this.notifyUIChanged()
  }

  recordFeatureInteraction(id: FeatureInteractionId): PersistedState['ui'] {
    const featureInteractions = normalizeFeatureInteractions(this.state.ui?.featureInteractions)
    const telemetryBuckets = normalizeFeatureInteractionTelemetryBuckets(
      this.state.featureInteractionTelemetryBuckets
    )
    const existing = featureInteractions[id]
    const previousCount = existing?.interactionCount ?? 0
    const nextCount = previousCount + 1
    const previousBucket = getFeatureInteractionUsageBucket(previousCount)
    const nextBucket = getFeatureInteractionUsageBucket(nextCount)
    const lastEmittedBucket = telemetryBuckets[id] ?? null
    const shouldEmit =
      nextBucket !== null &&
      (lastEmittedBucket === null ||
        compareFeatureInteractionUsageBuckets(nextBucket, lastEmittedBucket) > 0)

    this.updateUI({
      featureInteractions: {
        ...featureInteractions,
        [id]: {
          firstInteractedAt: existing?.firstInteractedAt ?? Date.now(),
          interactionCount: nextCount
        }
      }
    })
    this.state.featureInteractionTelemetryBuckets = shouldEmit
      ? { ...telemetryBuckets, [id]: nextBucket }
      : telemetryBuckets
    this.scheduleSave()

    if (shouldEmit) {
      track('feature_interaction_usage_bucket_reached', {
        feature_id: id,
        feature_category: getFeatureInteractionCategory(id),
        count_bucket: nextBucket,
        bucket_source:
          lastEmittedBucket === null && previousBucket !== null && previousBucket === nextBucket
            ? 'observed_existing'
            : 'crossed_now',
        ...getCohortAtEmit()
      })
    }
    return this.getUI()
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
    this.state.githubCache = cache
    this.scheduleSave()
  }

  // ── Workspace Session ─────────────────────────────────────────────

  /** Resolve an execution host argument to a canonical id. Unknown/empty
   *  values fall back to 'local' so legacy callers without a hostId keep
   *  reading and writing the local partition exactly as before. */
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

  readTerminalScrollbackSnapshot(ref: string): string | null {
    return readTerminalScrollbackSnapshotSync(ref)
  }

  /** Resolve the worktree a terminal tab belongs to, from the session's
   *  tab→worktree map. More reliable than agent-echoed hook fields. */
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

  /** Persist a non-'local' host partition. The PTY-binding race protections in
   *  setLocalWorkspaceSession only apply to the local daemon, so remote hosts
   *  take the lighter prune-and-store path. */
  private setHostWorkspaceSession(hostId: ExecutionHostId, session: WorkspaceSessionState): void {
    const pruned = pruneWorkspaceSessionBrowserHistory(
      pruneLocalTerminalScrollbackBuffers(session, this.state.repos)
    )
    this.state.workspaceSessionsByHostId = {
      ...this.state.workspaceSessionsByHostId,
      [hostId]: pruned
    }
    this.scheduleSave()
  }

  private setLocalWorkspaceSession(session: PersistedState['workspaceSession']): void {
    session = pruneWorkspaceSessionBrowserHistory(
      pruneLocalTerminalScrollbackBuffers(session, this.state.repos)
    )

    // Why: closes the second half of the SIGKILL race (Issue #217). The
    // renderer's debounced session writer captures its state BEFORE pty:spawn
    // returns, so the snapshot it later flushes via session:set has no
    // tab.ptyId / ptyIdsByLeafId for the just-spawned PTY. If that stale
    // snapshot lands AFTER persistPtyBinding's sync flush, it would overwrite
    // the durable binding and re-open the orphan window. Merge in any
    // existing bindings whenever the incoming snapshot's binding is empty.
    const prior = this.state.workspaceSession
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
      agentHookServer.registerPaneKeyAlias(
        entry.legacyPaneKey,
        entry.stablePaneKey,
        entry.ptyId,
        entry.updatedAt,
        { overwriteExisting: false }
      )
    }
    session = normalized.session
    const remappedLeases = remapSshRemotePtyLeaseLeafIds(
      this.state.sshRemotePtyLeases ?? [],
      normalized.leafIdByInputLeafIdByTabId,
      normalized.leafIdByPtyIdByTabId
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
              // Why: an empty layout map can be a stale pre-spawn snapshot; a
              // partial map is intentional unless a durable SSH lease proves it.
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
          // Why: the same stale session write that drops ptyIdsByLeafId can
          // also be from an older renderer that lacks UUID-keyed metadata.
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
    const migratedScrollback = migrateWorkspaceSessionTerminalScrollbackSnapshots(session)
    session = migratedScrollback.session
    deleteRemovedTerminalScrollbackSnapshots(prior, session)
    this.state.workspaceSession = session
    this.scheduleSave()
  }

  patchWorkspaceSession(patch: WorkspaceSessionPatch, hostId?: string | null): void {
    const resolved = this.resolveHostId(hostId)
    // Why: the renderer's debounced hot path sends only changed top-level
    // session slices. Scalar/UI patches avoid the terminal normalization path;
    // terminal topology/layout patches still reuse the stale-PTY protections.
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
    // Why: remote PTY ids are scoped to a relay target. Workspace PTY bindings
    // only store the id, so derive target/context when possible and require
    // stored lease context to match instead of treating missing fields as
    // wildcards that can tombstone unrelated panes.
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

  private sshRemotePtyLeaseMayReferenceBinding(
    lease: SshRemotePtyLease,
    binding: {
      ptyId: string
      targetId: string
      worktreeId?: string
      tabId?: string
      leafId?: string
    }
  ): boolean {
    const bindingPtyId = this.getRelayPtyIdForSshLeaseComparison(binding.targetId, binding.ptyId)
    if (lease.targetId !== binding.targetId || lease.ptyId !== bindingPtyId) {
      return false
    }
    // Why: target removal is destructive. Legacy/contextless leases should
    // scrub matching workspace bindings before the lease record is deleted,
    // otherwise removing the tombstone can let stale PTY ids revive later.
    return (
      (binding.worktreeId === undefined ||
        lease.worktreeId === undefined ||
        lease.worktreeId === binding.worktreeId) &&
      (binding.tabId === undefined || lease.tabId === undefined || lease.tabId === binding.tabId) &&
      (binding.leafId === undefined ||
        lease.leafId === undefined ||
        lease.leafId === binding.leafId)
    )
  }

  private getConnectionIdForWorktree(worktreeId: string): string | null {
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    return this.state.repos.find((repo) => repo.id === repoId)?.connectionId ?? null
  }

  // Why: closes the SIGKILL-between-spawn-and-persist race (Issue #217). The
  // renderer's debounced session writer (~450 ms total) is normally the only
  // path that writes tab.ptyId / ptyIdsByLeafId; a force-quit inside that
  // window orphans the daemon's history dir. Patching + sync flushing here
  // before pty:spawn returns guarantees the renderer cannot observe a
  // spawn-success without the binding already being durable on disk.
  persistPtyBinding(args: {
    worktreeId: string
    tabId: string
    leafId: string
    ptyId: string
  }): void {
    const session = this.state.workspaceSession
    if (!session) {
      return
    }
    const sessionBeforeBinding = cloneWorkspaceSessionState(session)
    const tabs = session.tabsByWorktree?.[args.worktreeId]
    const tab = tabs?.find((t) => t.id === args.tabId)
    if (tab) {
      tab.ptyId = args.ptyId
    } else {
      // Why: pty:spawn can beat the debounced session writer for a newly
      // created tab. Persist a minimal tab so hydration does not prune the
      // crash-safe layout binding below as an orphaned tab id.
      const nextTabs = [
        ...(tabs ?? []),
        createMinimalPersistedTerminalTab({
          ...args,
          existingTabCount: tabs?.length ?? 0
        })
      ]
      session.tabsByWorktree = {
        ...session.tabsByWorktree,
        [args.worktreeId]: nextTabs
      }
      session.activeWorktreeId ??= args.worktreeId
      session.activeTabId ??= args.tabId
      session.activeTabIdByWorktree = {
        ...session.activeTabIdByWorktree,
        [args.worktreeId]: session.activeTabIdByWorktree?.[args.worktreeId] ?? args.tabId
      }
    }
    if (!isTerminalLeafId(args.leafId)) {
      // Why: legacy renderer-local pane ids may arrive from older callers; keep
      // them out of durable leaf-keyed layout state after the UUID migration.
      try {
        this.flushOrThrow()
      } catch (err) {
        this.state.workspaceSession = sessionBeforeBinding
        throw err
      }
      return
    }
    const layout = session.terminalLayoutsByTabId?.[args.tabId]
    if (layout) {
      if (!layout.root) {
        // Why: createTab can persist an empty layout before TerminalPane mounts.
        // The sync spawn binding must still leave a durable UUID root behind.
        layout.root = { type: 'leaf', leafId: args.leafId }
        layout.activeLeafId = args.leafId
        layout.expandedLeafId = null
      } else if (!layoutContainsLeafId(layout.root, args.leafId)) {
        // Why: splitPane publishes the new pane and starts pty:spawn before the
        // debounced full layout snapshot reaches main. Add a minimal leaf so a
        // crash in that window cannot make the new pane's binding unreachable.
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
      // Why: first-spawn-ever for a new tab — the renderer's debounced writer
      // creates the layout entry on PaneManager init, but the binding has to
      // be on disk before pty:spawn returns or a SIGKILL inside the same
      // window would lose ptyIdsByLeafId for split-pane cold restore. The
      // renderer will overwrite this minimal layout once persistLayoutSnapshot
      // fires.
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
    try {
      this.flushOrThrow()
    } catch (err) {
      this.state.workspaceSession = sessionBeforeBinding
      throw err
    }
  }

  // ── SSH Targets ────────────────────────────────────────────────────

  getSshTargets(): SshTarget[] {
    return (this.state.sshTargets ?? []).map(normalizeSshTarget)
  }

  getSshTarget(id: string): SshTarget | undefined {
    const target = this.state.sshTargets?.find((t) => t.id === id)
    return target ? normalizeSshTarget(target) : undefined
  }

  addSshTarget(target: SshTarget): void {
    this.state.sshTargets ??= []
    this.state.sshTargets.push(normalizeSshTarget(target))
    this.scheduleSave()
  }

  updateSshTarget(id: string, updates: Partial<Omit<SshTarget, 'id'>>): SshTarget | null {
    const target = this.state.sshTargets?.find((t) => t.id === id)
    if (!target) {
      return null
    }
    const normalized = normalizeSshTarget({ ...target, ...updates })
    Object.assign(target, updates, normalized)
    if (!Object.hasOwn(normalized, 'relayGracePeriodSeconds')) {
      delete target.relayGracePeriodSeconds
    }
    if (!Object.hasOwn(normalized, 'systemSshConnectionReuse')) {
      delete target.systemSshConnectionReuse
    }
    this.scheduleSave()
    return { ...target }
  }

  removeSshTarget(id: string): void {
    if (!this.state.sshTargets) {
      return
    }
    this.state.sshTargets = this.state.sshTargets.filter((t) => t.id !== id)
    this.scheduleSave()
  }

  // ── SSH Remote PTY Leases ──────────────────────────────────────────

  getSshRemotePtyLeases(targetId?: string): SshRemotePtyLease[] {
    const leases = this.state.sshRemotePtyLeases ?? []
    return leases.filter((lease) => targetId === undefined || lease.targetId === targetId)
  }

  upsertSshRemotePtyLease(
    lease: Omit<SshRemotePtyLease, 'createdAt' | 'updatedAt'> &
      Partial<Pick<SshRemotePtyLease, 'createdAt' | 'updatedAt'>>
  ): void {
    this.state.sshRemotePtyLeases ??= []
    const normalizedLease = { ...lease }
    if (normalizedLease.leafId !== undefined && !isTerminalLeafId(normalizedLease.leafId)) {
      delete normalizedLease.leafId
    }
    // Why: app-facing SSH PTY ids are globally scoped; durable relay leases
    // stay target-local so reconnect can call relay pty.attach with raw ids.
    normalizedLease.ptyId = this.getRelayPtyIdForSshLeaseStorage(
      normalizedLease.targetId,
      normalizedLease.ptyId
    )
    const now = Date.now()
    const existingIndex = this.state.sshRemotePtyLeases.findIndex(
      (entry) =>
        entry.targetId === normalizedLease.targetId && entry.ptyId === normalizedLease.ptyId
    )
    const existing = existingIndex >= 0 ? this.state.sshRemotePtyLeases[existingIndex] : undefined
    const next: SshRemotePtyLease = {
      ...existing,
      ...normalizedLease,
      createdAt: existing?.createdAt ?? normalizedLease.createdAt ?? now,
      updatedAt: normalizedLease.updatedAt ?? now
    }
    if (existingIndex >= 0) {
      this.state.sshRemotePtyLeases[existingIndex] = next
    } else {
      this.state.sshRemotePtyLeases.push(next)
    }
    this.flush()
  }

  markSshRemotePtyLeases(targetId: string, state: SshRemotePtyLease['state']): void {
    const now = Date.now()
    let changed = false
    const shouldClearBindings = state === 'terminated' || state === 'expired'
    const leasesToClear: SshRemotePtyLease[] = []
    this.state.sshRemotePtyLeases ??= []
    for (const lease of this.state.sshRemotePtyLeases) {
      if (lease.targetId !== targetId) {
        continue
      }
      if (state === 'detached' && lease.state !== 'attached') {
        continue
      }
      if (lease.state !== state) {
        lease.state = state
        lease.updatedAt = now
        if (state === 'attached') {
          lease.lastAttachedAt = now
        } else if (state === 'detached') {
          lease.lastDetachedAt = now
        }
        changed = true
      }
      if (shouldClearBindings) {
        leasesToClear.push(lease)
      }
    }
    const bindingsChanged = shouldClearBindings
      ? this.clearSshRemotePtyBindingsForLeases(targetId, leasesToClear)
      : false
    if (changed || bindingsChanged) {
      this.flush()
    }
  }

  markSshRemotePtyLease(targetId: string, ptyId: string, state: SshRemotePtyLease['state']): void {
    const relayPtyId = this.getRelayPtyIdForSshLeaseStorage(targetId, ptyId)
    const lease = this.state.sshRemotePtyLeases?.find(
      (entry) => entry.targetId === targetId && entry.ptyId === relayPtyId
    )
    if (!lease) {
      return
    }
    const shouldClearBindings = state === 'terminated' || state === 'expired'
    if (lease.state === state) {
      if (shouldClearBindings && this.clearSshRemotePtyBindingsForLeases(targetId, [lease])) {
        this.flush()
      }
      return
    }
    const now = Date.now()
    lease.state = state
    lease.updatedAt = now
    if (state === 'attached') {
      lease.lastAttachedAt = now
    } else if (state === 'detached') {
      lease.lastDetachedAt = now
    }
    if (shouldClearBindings) {
      this.clearSshRemotePtyBindingsForLeases(targetId, [lease])
    }
    this.flush()
  }

  removeSshRemotePtyLease(targetId: string, ptyId: string): void {
    const relayPtyId = this.getRelayPtyIdForSshLeaseStorage(targetId, ptyId)
    const leases = (this.state.sshRemotePtyLeases ?? []).filter(
      (lease) => lease.targetId === targetId && lease.ptyId === relayPtyId
    )
    const before = this.state.sshRemotePtyLeases?.length ?? 0
    this.clearSshRemotePtyBindingsForLeases(targetId, leases)
    this.state.sshRemotePtyLeases = (this.state.sshRemotePtyLeases ?? []).filter(
      (lease) => lease.targetId !== targetId || lease.ptyId !== relayPtyId
    )
    if (this.state.sshRemotePtyLeases.length !== before) {
      this.flush()
    }
  }

  removeSshRemotePtyLeases(targetId: string): void {
    this.state.sshRemotePtyLeases ??= []
    this.clearSshRemotePtyBindingsForTarget(targetId)
    const before = this.state.sshRemotePtyLeases.length
    this.state.sshRemotePtyLeases = this.state.sshRemotePtyLeases.filter(
      (lease) => lease.targetId !== targetId
    )
    if (this.state.sshRemotePtyLeases.length !== before) {
      this.flush()
    }
  }

  private clearSshRemotePtyBindingsForTarget(targetId: string): void {
    const leases = this.state.sshRemotePtyLeases?.filter((lease) => lease.targetId === targetId)
    this.clearSshRemotePtyBindingsForLeases(targetId, leases ?? [])
  }

  private clearSshRemotePtyBindingsForLeases(
    targetId: string,
    leases: SshRemotePtyLease[]
  ): boolean {
    const session = this.state.workspaceSession
    if (!leases?.length || !session) {
      return false
    }
    let changed = false
    for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree ?? {})) {
      for (const tab of tabs) {
        if (
          tab.ptyId &&
          leases.some((lease) =>
            this.sshRemotePtyLeaseMayReferenceBinding(lease, {
              ptyId: tab.ptyId!,
              worktreeId,
              targetId,
              tabId: tab.id
            })
          )
        ) {
          tab.ptyId = null
          changed = true
        }
      }
    }
    for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId ?? {})) {
      const bindings = layout.ptyIdsByLeafId
      if (!bindings) {
        continue
      }
      const worktreeId = Object.entries(session.tabsByWorktree ?? {}).find(([, tabs]) =>
        tabs.some((tab) => tab.id === tabId)
      )?.[0]
      const nextBindings = Object.fromEntries(
        Object.entries(bindings).filter(
          ([leafId, ptyId]) =>
            !leases.some((lease) =>
              this.sshRemotePtyLeaseMayReferenceBinding(lease, {
                ptyId,
                targetId,
                worktreeId,
                tabId,
                leafId
              })
            )
        )
      )
      if (Object.keys(nextBindings).length !== Object.keys(bindings).length) {
        layout.ptyIdsByLeafId = nextBindings
        changed = true
      }
    }
    if (changed) {
      this.scheduleSave()
    }
    return changed
  }

  // ── Flush (for shutdown) ───────────────────────────────────────────

  flush(): void {
    try {
      this.flushOrThrow()
    } catch (err) {
      console.error('[persistence] Failed to flush state:', err)
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
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: Date.now(),
    lastActivityAt: 0,
    workspaceStatus: DEFAULT_WORKSPACE_STATUS_ID
  }
}
