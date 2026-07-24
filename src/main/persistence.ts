/* eslint-disable max-lines -- Why: persistence keeps schema defaults, migration, and load/save/flush in one file so the storage contract reviews as a unit. */
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
  PersistedMobileClientTabSelections,
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
import { normalizePersistedMobileClientTabSelections } from './runtime/client-session-tab-selection-persistence'
import { sanitizeWorkspaceSessionTerminalRetirements } from './runtime/mobile-session-terminal-persistence-retirement'
import {
  removeRepoFromHostWorkspaceSessions,
  removeRepoFromWorkspaceSession
} from './orca-profiles/profile-project-session-state'
import { hardenExistingSecureFile } from '../shared/secure-file'
import {
  LEGACY_DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS,
  type RemovedSshTargetTombstone,
  type SshRemotePtyLease,
  type SshTarget
} from '../shared/ssh-types'
import { isFolderRepo } from '../shared/repo-kind'
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
import { normalizeUsagePercentageDisplay } from '../shared/usage-percentage-display'
import { normalizeStatusBarUsageMode } from '../shared/status-bar-usage-mode'
import { isExistingPersistedProfile } from '../shared/project-order-manual-default-notice'
import { resolveUsagePercentageDisplayChangeNoticeDismissed } from '../shared/usage-percentage-display-change-notice'
import { normalizePRBotAuthorOverrides } from '../shared/pr-bot-author-overrides'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostOrder,
  normalizeExecutionHostId,
  normalizeVisibleExecutionHostIds,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../shared/execution-host'
import { toRelaySshPtyId } from './providers/ssh-pty-id'
import {
  migrateUiHostScopeSshTargetId,
  migrateWorkspaceSessionSshTargetId
} from './ssh/ssh-target-id-migration'
import { isWslUncPath } from '../shared/wsl-paths'
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
import {
  backfillAutomationRunNumbers,
  nextAutomationRunNumber,
  pruneAutomationRuns
} from '../shared/automation-run-retention'
import { pruneWorkspaceSessionBrowserHistory } from '../shared/workspace-session-browser-history'
import {
  FOLDER_WORKSPACE_INSTANCE_SEPARATOR,
  getRepoIdFromWorktreeId,
  getWorktreePathBasenameFromId
} from '../shared/worktree-id'
import {
  isPathInsideOrEqual,
  isWindowsAbsolutePathLike,
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
import { normalizeManualRepoOrder } from '../shared/manual-repo-order'
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
import { normalizeTerminalLineHeight } from '../shared/terminal-line-height-settings'
import { normalizeUiLanguage } from '../shared/ui-language'
import { normalizeBrowserPageZoomLevel } from '../shared/browser-page-zoom'
import { persistedUIValuesEqual } from '../shared/persisted-ui-equality'
import { ActiveViewPreference } from './active-view-preference'
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
  getProfileTerminalScrollbackSnapshotRoot,
  migrateWorkspaceSessionTerminalScrollbackSnapshots,
  readTerminalScrollbackSnapshotSync,
  type TerminalScrollbackSnapshotStorage
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
    // Why: decrypt failure usually means plaintext (pre-encryption) or a changed keychain; return raw so the cookie survives upgrade.
    console.warn(
      '[persistence] safeStorage decryption failed — returning ciphertext as-is. Possible keychain reset.'
    )
    return ciphertext
  }
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
    // Why: {basePrompt} is the explicit clear state; an empty instruction shadows rollback commitMessageAi.customPrompt on normalize/project.
    instructionsByOperation = { ...instructionsByOperation, [actionId]: '' }
    changed = true
  }

  return changed ? { ...sourceControlAi, instructionsByOperation } : sourceControlAi
}

// Why capture once (not a module const, not per-call): a const resolves before configureDevUserDataPath() redirects userData (dev/prod collide);
// per-call resolves after app.setName('Orca') flips path case and loses data on case-sensitive FS. index.ts calls initDataPath() at the right moment.
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

// Why a sidecar: githubCache refreshes every poll and would rewrite the whole multi-MB orca-data.json each cycle.
// Snapshotted best-effort at quit for instant badges next launch; safe to lose.
function getGithubCacheFile(dataFile = getDataFile()): string {
  return join(dirname(dataFile), 'orca-github-cache.json')
}

// Why: worktrees deleted outside Orca orphan their worktreeMeta, so the map grew monotonically (63% dead on a heavy install).
// GC stays narrow: local-host entries only (a local existsSync would falsely condemn SSH/WSL remote paths) and only after a 30-day idle grace.
const WORKTREE_META_GC_GRACE_MS = 30 * 24 * 60 * 60 * 1000

function gcStaleWorktreeMeta(state: PersistedState): number {
  // Why: a hand-corrupted "worktreeMeta": null overrides the defaults merge; normalize here instead of throwing.
  state.worktreeMeta ??= {}
  const repoById = new Map(state.repos.map((repo) => [repo.id, repo]))
  const projectIds = new Set((state.projects ?? []).map((project) => project.id))
  const now = Date.now()
  let removed = 0
  for (const key of Object.keys(state.worktreeMeta)) {
    // Why: folder-project workspace instances (keyed repoId::path::workspace:<uuid>) ARE the workspace record, not a checkout row; skip them.
    if (key.includes(FOLDER_WORKSPACE_INSTANCE_SEPARATOR)) {
      continue
    }
    const separator = key.indexOf('::')
    if (separator === -1) {
      continue
    }
    const ownerId = key.slice(0, separator)
    const worktreePath = key.slice(separator + 2)
    const meta = state.worktreeMeta[key]
    const repo = repoById.get(ownerId)
    if (repo) {
      if (repo.connectionId || getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
        continue
      }
    } else if (projectIds.has(ownerId)) {
      // Project-owned metas keep their own project/host lifecycle; leave them alone.
      continue
    }
    // Unowned entries (repo removed before metas were pruned) fall through to the same missing-path + idle-grace gate.
    if (meta?.hostId && meta.hostId !== LOCAL_EXECUTION_HOST_ID) {
      continue
    }
    if (!isAbsolute(worktreePath) || isWslUncPath(worktreePath)) {
      continue
    }
    // Why: WSL worktrees on Windows carry Linux-style paths that Windows existsSync can't probe and would falsely condemn.
    if (process.platform === 'win32' && !isWindowsAbsolutePathLike(worktreePath)) {
      continue
    }
    // Why keep timestamp-less entries: without timestamps we can't prove the 30-day grace elapsed (measured dead entries all had them).
    // Grace is checked before existsSync so active entries skip the stat fan-out (and its slow-NFS tail).
    const newestTouch = Math.max(meta?.lastActivityAt ?? 0, meta?.createdAt ?? 0)
    if (newestTouch === 0 || now - newestTouch < WORKTREE_META_GC_GRACE_MS) {
      continue
    }
    if (existsSync(worktreePath)) {
      continue
    }
    delete state.worktreeMeta[key]
    delete state.worktreeLineageById[key]
    delete state.workspaceLineageByChildKey[worktreeWorkspaceKey(key)]
    removed++
  }
  return removed
}

function readGithubCacheSnapshot(dataFile: string): PersistedState['githubCache'] | null {
  try {
    const parsed = JSON.parse(readFileSync(getGithubCacheFile(dataFile), 'utf-8')) as unknown
    const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
    if (
      isPlainRecord(parsed) &&
      isPlainRecord((parsed as { pr?: unknown }).pr) &&
      isPlainRecord((parsed as { issue?: unknown }).issue)
    ) {
      return parsed as PersistedState['githubCache']
    }
  } catch {
    // Missing or corrupt snapshot: start with an empty cache and refetch.
  }
  return null
}

/**
 * Return the userData directory captured at initDataPath() time, before app.setName() can change how app.getPath('userData') resolves.
 *
 * Subsystems sharing storage with orca-data.json read this instead of resolving late, which on case-sensitive FS can lose paired devices.
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
 * Copies the registry and E2EE keypair forward as a pair so an update doesn't force a re-pair or mix devices with the wrong key.
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
    // Why: copyFileSync drops Windows ACLs, so re-assert current-user-only on these credential copies (device tokens, E2EE key).
    hardenExistingSecureFile(targetPath)
  }
}

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

/** Normalize non-'local' host partitions; 'local' (the legacy workspaceSession blob) is dropped so the two surfaces never diverge.
 *  Each partition is zod-validated independently, so one corrupt host drops to defaults without taking out the others. Idempotent. */
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
    // Why: 'local' lives in workspaceSession; a local/invalid key here is legacy noise that must not shadow the canonical partition.
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
    // Why: legacy users could only customize launch defaults via command overrides, so those agents count as already user-owned.
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
      // Why: pre-host-context automations only stored a repo id; backfill the run target once so dispatch/precheck stop inferring it.
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

// Why: old targets predate configHost; default to label-based lookup so imported SSH aliases still resolve via ssh -G.
function normalizeSshTarget(t: SshTarget): SshTarget {
  const target = { ...(t as LegacySshTarget) }
  const legacySyncEnabled = target.remoteWorkspaceSyncEnabled
  const currentGracePeriodSeconds = target.relayGracePeriodSeconds
  const legacyGracePeriodSeconds = target.remoteWorkspaceSyncGracePeriodSeconds
  const systemSshConnectionReuse = target.systemSshConnectionReuse
  // Why: remote sync now follows the SSH relay lifecycle, so retired per-target sync/grace fields are dropped at disk load.
  delete target.remoteWorkspaceSyncEnabled
  delete target.remoteWorkspaceSyncGracePeriodSeconds
  delete target.relayGracePeriodSeconds
  delete target.systemSshConnectionReuse
  // Why: prefer the synced grace over stale relayGracePeriodSeconds so a user's "unlimited" (0) survives migration.
  const relayGracePeriodSeconds =
    legacySyncEnabled === true && typeof legacyGracePeriodSeconds === 'number'
      ? legacyGracePeriodSeconds
      : currentGracePeriodSeconds
  const normalized: SshTarget = {
    ...target,
    configHost: target.configHost ?? target.label ?? target.host
  }
  // Why: old SSH form persisted 10800 even without a user choice; treat that legacy default as the new implicit default.
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

// Why: strict whitelist rejects unknown/bad-typed keys; returns Partial so partial updates don't clobber valid persisted state.
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
  // Why: v3 (pre-Windows-terminal-page) step 4 already meant notifications, so resume there, not the inserted Windows step.
  if (raw.flowVersion === 3) {
    return Math.min(4, lastCompletedStep)
  }
  // Why: v2's five-step flow had step 4 = removed agent setup, not completed integrations.
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
    // Why: NaN/Infinity serialize to null on save, reverting closedAt and reopening the wizard; require a finite timestamp.
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
      // Why: removing two wizard pages changed step numbering; migrate legacy values before the final-step bound drops them.
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
      // Why: copy ONLY caller-sent boolean keys so partial updates don't reset other checklist items to false.
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
  // Why: an existing file with no onboarding block is an upgrade user; backfill as completed so they skip the wizard.
  if (!input) {
    return {
      ...defaults,
      closedAt: Date.now(),
      outcome: 'completed',
      lastCompletedStep: ONBOARDING_FINAL_STEP
    }
  }
  // Why: sanitize persisted onboarding keys so a type-flipped field on disk can't poison in-memory state.
  const sanitized = sanitizeOnboardingUpdate(input, {
    migrateLegacyProgress: true
  })
  // Why: a completed/dismissed outcome means the user left; recover a bad closedAt instead of reopening the checklist.
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
  // Why: once onboarding is closed, persisted false is just the old default, not a user opt-in to the sidebar checklist.
  return onboarding.closedAt !== null || persistedDismissed === true
}

// Why: read a settings field removed from GlobalSettings but still on disk; one-shot for the inline-agents migration.
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
    // Why: PaneManager ids are 1-based; a zero-based alias in split layouts makes tab:1 ambiguous and misroutes panes.
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
  // Why: legacy numeric pane keys are now bridged by aliases, not persisted as restart-required rows.
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
    // Why: pre-stable rows lack the old numeric key; only synthesize single-pane aliases when the row is unambiguous.
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
    // Why: a debounced renderer writer can still hold the createTab-era empty layout after the UUID root was sync-flushed.
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
    // Why: old split layouts can generate enough alias rows to exceed V8's argument limit if spread into push().
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
    // Why: unmatched legacy leaf ids are ambiguous after migration; don't re-persist them as durable pane identity.
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
      // Why: when a legacy leaf is promoted to a UUID, carry the read marker over so seen rows don't come back unread.
      setAcknowledgement(makePaneKey(tabId, remappedLeafId), acknowledgedAt)
      changed = true
    } catch {
      setAcknowledgement(paneKey, acknowledgedAt)
    }
  }

  return { acknowledgements: next, changed }
}

// Why: bounds a corrupt/bloated persisted list — the gate only needs the few Claude sessions a daemon can keep alive.
const MAX_CLAUDE_LIVE_PTY_SESSION_IDS = 200

// Why: bound removed-SSH-target history so remove/re-add churn can't grow the file unbounded.
const MAX_REMOVED_SSH_TARGET_TOMBSTONES = 50

function normalizeClaudeLivePtySessionIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  // Why: scan newest-first so the cap keeps the most recent ids, matching addClaudeLivePtySessionId's eviction policy.
  const ids: string[] = []
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const entry = value[index]
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 512) {
      continue
    }
    if (!ids.includes(entry)) {
      ids.push(entry)
    }
    if (ids.length >= MAX_CLAUDE_LIVE_PTY_SESSION_IDS) {
      break
    }
  }
  return ids.toReversed()
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
    const relocatedSource = parsePaneKey(candidate.legacyPaneKey)
    const stable = parsePaneKey(candidate.stablePaneKey)
    return Boolean(stable && ((legacy && legacy.tabId === stable.tabId) || relocatedSource))
  })
}

function registerPersistedPaneKeyAlias(entry: LegacyPaneKeyAliasEntry): void {
  if (parseLegacyNumericPaneKey(entry.legacyPaneKey)) {
    agentHookServer.registerPaneKeyAlias(
      entry.legacyPaneKey,
      entry.stablePaneKey,
      entry.ptyId,
      entry.updatedAt,
      { overwriteExisting: false }
    )
    return
  }
  // Why: detached agents keep their UUID pane key across restarts; restore the physical-to-owner mapping before hook replay.
  agentHookServer.transferPaneAuthority(
    entry.legacyPaneKey,
    entry.stablePaneKey,
    entry.ptyId,
    entry.updatedAt,
    { authorityVerified: false }
  )
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
  // Why: legacy/repo-backed setup rows reuse the repo id; keep only independent rows so repo deletion leaves no ghosts.
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
  startupCwd?: string
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
    ...(args.startupCwd ? { startupCwd: args.startupCwd } : {}),
    pendingActivationSpawn: true
  }
}

function cloneWorkspaceSessionState(session: WorkspaceSessionState): WorkspaceSessionState {
  return structuredClone(session)
}

function removeWorkspaceSessionOwner(
  session: WorkspaceSessionState | undefined,
  ownerKey: string,
  options: { advanceTerminalTopologyRevision?: boolean } = {}
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
  if (next.terminalPtyIncarnationsByPaneKey) {
    const removedTabIds = new Set(removedTerminalTabs.map((tab) => tab.id))
    next.terminalPtyIncarnationsByPaneKey = Object.fromEntries(
      Object.entries(next.terminalPtyIncarnationsByPaneKey).filter(([paneKey]) => {
        const separator = paneKey.lastIndexOf(':')
        return separator < 1 || !removedTabIds.has(paneKey.slice(0, separator))
      })
    )
  }
  if (next.terminalSurfaceTombstonesByPaneKey) {
    next.terminalSurfaceTombstonesByPaneKey = Object.fromEntries(
      Object.entries(next.terminalSurfaceTombstonesByPaneKey).filter(
        ([, tombstone]) => tombstone.worktreeId !== ownerKey
      )
    )
  }
  const repoId = getRepoIdFromWorktreeId(ownerKey)
  const previousTopologyRevision = next.terminalTopologyRevisionByRepoId?.[repoId] ?? 0
  if (options.advanceTerminalTopologyRevision) {
    next.terminalTopologyRevisionByRepoId = {
      ...next.terminalTopologyRevisionByRepoId,
      [repoId]: previousTopologyRevision + 1
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

export class Store {
  private state: PersistedState
  private readonly dataFile: string
  private readonly activeViewPreference: ActiveViewPreference
  private readonly terminalScrollbackSnapshotStorage: TerminalScrollbackSnapshotStorage
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  private pendingWrite: Promise<void> | null = null
  private writeGeneration = 0
  // Why: after a profile transfer rewrites this file on disk, a late flush of stale in-memory state would resurrect the moved project.
  private writesFrozen = false
  // Content hash at last write, to skip no-op writes; derived from the payload with encrypted blobs normalized back to plaintext (see buildStateToSave), since encrypt() uses a random IV per call.
  private lastWrittenStateHash: string | null = null
  private firstPendingSaveAt: number | null = null
  private githubCacheDirty = false
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

  constructor(options: StoreOptions = {}) {
    // Why: profile switching yields multiple state paths; capture per Store so late async writes can't follow a global path.
    this.dataFile = options.dataFile ?? getDataFile()
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

  // Why: rotate current file into the .bak ring so load() can recover if a later primary write is truncated or corrupt.
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
          mobileClientTabSelectionsByDeviceId: normalizePersistedMobileClientTabSelections(
            parsed.mobileClientTabSelectionsByDeviceId
          ),
          workspaceLineageByChildKey: normalizeWorkspaceLineageByChildKey(
            parsed.workspaceLineageByChildKey
          ),
          settings: {
            ...defaults.settings,
            // Why (#7977): keep persisted experimentalNewWorktreeCardStyle:true — v1.4.130's onboarding auto-wrote it as a plain boolean, so it's indistinguishable from a real opt-in; only the default changed.
            ...stripLegacyTerminalScrollbackBytes(parsed.settings),
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
            notifications: normalizeNotificationSettings(parsed.settings?.notifications),
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
              setupGuideSidebarDismissed,
              usagePercentageDisplayChangeNoticeDismissed,
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
              // Why: keep stamping the legacy flag for rollback forward-compat; the new flag actually gates the migration.
              _inlineAgentsDefaultedForExperiment: true,
              _inlineAgentsDefaultedForAllUsers: true,
              _expandedWorktreeCardPropertiesDefaulted: true
            }
          })(),
          // Why: volatile schema; zod-validate workspaceSession at read so a bad payload falls to defaults, not a renderer crash.
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
          // Why: per-host session partitions, validated independently; 'local' stays in workspaceSession for downgrade compat.
          workspaceSessionsByHostId: parseWorkspaceSessionsByHostId(
            parsed.workspaceSessionsByHostId,
            defaults.workspaceSession
          ),
          sshTargets: (parsed.sshTargets ?? []).map(normalizeSshTarget),
          deletedSshConfigAliases: Array.isArray(parsed.deletedSshConfigAliases)
            ? parsed.deletedSshConfigAliases.filter(
                (alias): alias is string => typeof alias === 'string'
              )
            : [],
          sshRemotePtyLeases: (parsed.sshRemotePtyLeases ?? [])
            .map(normalizeSshRemotePtyLease)
            .filter((lease): lease is SshRemotePtyLease => lease !== null),
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
      // Why (issue #1158): serialize async writes so backup rotation can't race two callers over the same paths.
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
    await Promise.all([this.pendingWrite, this.activeViewPreference.waitForPendingWrite()])
  }

  // Why githubCache is omitted: memory-only this session (see getGithubCacheFile), so refreshes never touch the durable file.
  private getDurableState(): Omit<PersistedState, 'githubCache'> {
    const { githubCache: _memoryOnly, ...durable } = this.state
    return durable
  }

  // Why: build payload synchronously so hash and serialized bytes reflect the same state tick (no await interleave). One full-state stringify serves both the on-disk payload and the no-op-write guard hash: each secret slot is serialized as a fresh unguessable sentinel, then sentinels are substituted to ciphertext for the payload and to plaintext for the hash. The hash is thus a pure function of plaintext state (skips a byte-identical rewrite) without a second stringify.
  private buildStateToSave(): { payload: string; stateHash: string } {
    // Why sentinels (not a blob/key string match): the substitution must be
    // position-exact. A plain search for the ciphertext — or even for a
    // `"key":"blob"` token — can be mimicked by user-controlled state (e.g. an
    // agentDefaultEnv var named after a secret field, or a value equal to a
    // ciphertext), which would substitute the wrong site and let two DISTINCT
    // states normalize equal → a silently dropped write (data loss), reachable
    // on deterministic-IV platforms (macOS/legacy-Linux OSCrypt). A per-slot
    // random UUID can't occur anywhere else in the serialized state (the user
    // sets their data before it is minted), so it appears exactly once.
    const secretSubs: { sentinel: string; blob: string; plaintext: string }[] = []
    const encryptToSentinel = (plaintext: string): string => {
      const blob = encrypt(plaintext)
      // Deterministic already (empty secret / safeStorage unavailable / encrypt
      // failure): blob === plaintext, so no normalization — and no sentinel,
      // which also avoids substituting an empty or plaintext-shaped slot.
      if (blob === plaintext) {
        return blob
      }
      const sentinel = `orca-secret-slot-${randomUUID()}`
      secretSubs.push({ sentinel, blob, plaintext })
      return sentinel
    }
    // Why: clone before encrypting secrets so in-memory this.state stays plaintext.
    const stateToSave = {
      ...this.getDurableState(),
      settings: {
        ...this.state.settings,
        opencodeSessionCookie: encryptToSentinel(this.state.settings.opencodeSessionCookie),
        httpProxyUrl: encryptToSentinel(this.state.settings.httpProxyUrl ?? '')
      },
      ui: {
        ...this.state.ui,
        browserKagiSessionLink: this.state.ui.browserKagiSessionLink
          ? encryptToSentinel(this.state.ui.browserKagiSessionLink)
          : null
      }
    }
    // Why compact: ~20% fewer bytes and less serialize time; all readers JSON.parse so formatting is irrelevant.
    // One full-state stringify; secret slots currently hold sentinels.
    const serialized = JSON.stringify(stateToSave)
    // Substitute each unique sentinel exactly once: ciphertext for the on-disk
    // payload, plaintext for the guard hash. Function-form replacement keeps
    // `$` in blob/plaintext inert; both sides read the sentinel as JSON-escaped
    // in `serialized`, so each replace is byte-for-byte position-exact.
    let payload = serialized
    let hashInput = serialized
    for (const { sentinel, blob, plaintext } of secretSubs) {
      const escapedSentinel = JSON.stringify(sentinel).slice(1, -1)
      payload = payload.replace(escapedSentinel, () => blob)
      hashInput = hashInput.replace(escapedSentinel, () => JSON.stringify(plaintext).slice(1, -1))
    }
    const stateHash = createHash('sha1').update(hashInput).digest('hex')
    return { payload, stateHash }
  }

  // Why: async writes avoid blocking the main Electron thread on every debounced save.
  private async writeToDiskAsync(): Promise<void> {
    if (this.writesFrozen) {
      return
    }
    const gen = this.writeGeneration
    const { payload, stateHash } = this.buildStateToSave()
    // Why: don't rewrite a byte-identical multi-MB file when state nets out to already-persisted.
    if (stateHash === this.lastWrittenStateHash) {
      return
    }
    const dataFile = this.dataFile
    const dir = dirname(dataFile)
    await mkdir(dir, { recursive: true }).catch(() => {})
    const tmpFile = `${dataFile}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`

    // Why: on any write/rename failure, remove the tmp file so it doesn't leave a multi-MB orphan.
    let renamed = false
    try {
      await writeFile(tmpFile, payload, 'utf-8')
      // Why: if flush() bumped writeGeneration mid-write, it already wrote fresher state; don't overwrite it.
      if (this.writeGeneration !== gen) {
        return
      }
      await rename(tmpFile, dataFile)
      renamed = true
      // Why re-check gen: a sync flush during the rename await may have written fresher state; don't record a stale hash over it.
      if (this.writeGeneration === gen) {
        this.lastWrittenStateHash = stateHash
      }
    } finally {
      if (!renamed) {
        await rm(tmpFile).catch(() => {})
      }
    }
    // Why (issue #1158): rotate backups only after rename succeeded, and let a concurrent flush own rotation.
    if (this.writeGeneration !== gen) {
      return
    }
    const now = Date.now()
    if (this.shouldRotateBackups(now, dataFile)) {
      await this.rotateBackupsAsync(dataFile)
    }
  }

  // Why: sync variant only for flush() at shutdown, where the process may exit before an async write completes.
  private writeToDiskSync(opts: { force?: boolean } = {}): void {
    if (this.writesFrozen) {
      return
    }
    const { payload, stateHash } = this.buildStateToSave()
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

  flushOrThrow(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    this.firstPendingSaveAt = null
    const asyncWriteWasInFlight = this.pendingWrite !== null
    // Why: bump writeGeneration so an in-flight async write skips its rename and can't overwrite this sync write.
    this.writeGeneration++
    this.pendingWrite = null
    this.writeToDiskSync({ force: asyncWriteWasInFlight })
  }

  flushActiveViewPreferenceOrThrow(): void {
    this.activeViewPreference.flushOrThrow()
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
    // Why: persist independently so future repo projection sync doesn't erase this non-repo-backed setup.
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

  /** O(1) repo count; unlike `getRepos()` this skips per-repo hydration. */
  getRepoCount(): number {
    return this.state.repos.length
  }

  getRepo(id: string): Repo | undefined {
    const repo = this.state.repos.find((r) => r.id === id)
    return repo ? this.hydrateRepo(repo) : undefined
  }

  /**
   * Record a background-resolved git username; kept out of updateRepo's whitelist so the renderer can't write it directly.
   * @returns true when the hydrated value changed.
   */
  setResolvedRepoGitUsername(id: string, username: string): boolean {
    const repo = this.state.repos.find((r) => r.id === id)
    if (!repo) {
      return false
    }
    const previous = this.gitUsernameCache.get(repo.path) ?? repo.gitUsername ?? ''
    this.gitUsernameCache.set(repo.path, username)
    if (previous === username) {
      return false
    }
    if (username) {
      // Why: persist so the next launch hydrates repos with the right branch prefix before enrichment re-runs.
      repo.gitUsername = username
    } else {
      delete repo.gitUsername
    }
    this.scheduleSave()
    return true
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
    // Why: groups are sidebar organization only, so deleting one ungroups its repos rather than deleting them.
    this.state.repos = this.state.repos.map((repo) =>
      repo.projectGroupId && deletedGroupIds.has(repo.projectGroupId)
        ? { ...repo, projectGroupId: null }
        : repo
    )
    const removedFolderWorkspaceKeys = new Set<string>()
    for (const workspace of this.state.folderWorkspaces ?? []) {
      if (deletedGroupIds.has(workspace.projectGroupId)) {
        removedFolderWorkspaceKeys.add(folderWorkspaceKey(workspace.id))
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
    this.pruneMobileClientTabSelections((worktreeId) => removedFolderWorkspaceKeys.has(worktreeId))
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
    this.pruneMobileClientTabSelections((worktreeId) => worktreeId === folderWorkspaceKey(id))
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

  // Why: return false on a stale permutation (concurrent add/remove) so the caller resyncs instead of persisting an order that drops/duplicates ids.
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

  // Why: repo ids are unique only within an execution host; drags persist one permutation per host when local and SSH repos coexist.
  reorderReposForHost(orderedIds: string[], hostId: ExecutionHostId): boolean {
    const current = this.state.repos
    const hostRepos = current.filter((repo) => getRepoExecutionHostId(repo) === hostId)
    if (orderedIds.length !== hostRepos.length) {
      return false
    }
    const byId = new Map(hostRepos.map((repo) => [repo.id, repo]))
    if (byId.size !== hostRepos.length) {
      return false
    }
    const seen = new Set<string>()
    const reorderedHostRepos: Repo[] = []
    for (const id of orderedIds) {
      const repo = typeof id === 'string' && !seen.has(id) ? byId.get(id) : undefined
      if (!repo) {
        return false
      }
      seen.add(id)
      reorderedHostRepos.push(repo)
    }
    let nextHostIndex = 0
    this.state.repos = current.map((repo) =>
      getRepoExecutionHostId(repo) === hostId ? reorderedHostRepos[nextHostIndex++] : repo
    )
    this.syncProjectHostSetupCompatibilityState()
    this.scheduleSave()
    return true
  }

  removeProject(id: string): void {
    this.state.repos = this.state.repos.filter((r) => r.id !== id)
    this.syncProjectHostSetupCompatibilityState()
    // Why: presets are repo-scoped and unreachable once the repo is gone, so drop them with it.
    delete this.state.sparsePresetsByRepo[id]
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
    // Why: presets are repo-id-scoped (not host-scoped); drop them only when the last host's copy is gone.
    if (!idStillPresent) {
      delete this.state.sparsePresetsByRepo[id]
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
    const prefix = `${id}::`
    // Why snapshot up front: the first loop deletes metas, so reading meta.hostId live later would misclassify an SSH worktree as local.
    const hostMembership = new Map<string, boolean>()
    const belongsToHost = (key: string): boolean => {
      if (!key.startsWith(prefix)) {
        return false
      }
      if (hostId === null) {
        return true
      }
      const cached = hostMembership.get(key)
      if (cached !== undefined) {
        return cached
      }
      // Why default to local: metas without hostId predate host stamping, so a host-scoped prune skips them rather than risk deleting another host's live meta.
      const metaHostId = this.state.worktreeMeta[key]?.hostId ?? LOCAL_EXECUTION_HOST_ID
      const result = metaHostId === hostId
      hostMembership.set(key, result)
      return result
    }
    for (const key of Object.keys(this.state.worktreeMeta)) {
      if (belongsToHost(key)) {
        delete this.state.worktreeMeta[key]
      }
    }
    for (const [childId, lineage] of Object.entries(this.state.worktreeLineageById)) {
      if (belongsToHost(childId) || belongsToHost(lineage.parentWorktreeId)) {
        delete this.state.worktreeLineageById[childId]
      }
    }
    for (const [childKey, lineage] of Object.entries(this.state.workspaceLineageByChildKey)) {
      const childScope = parseWorkspaceKey(childKey)
      const parentScope = parseWorkspaceKey(lineage.parentWorkspaceKey)
      if (childScope?.type === 'worktree' && belongsToHost(childScope.worktreeId)) {
        delete this.state.workspaceLineageByChildKey[childKey as WorkspaceKey]
        continue
      }
      if (parentScope?.type === 'worktree' && belongsToHost(parentScope.worktreeId)) {
        delete this.state.workspaceLineageByChildKey[childKey as WorkspaceKey]
      }
    }
    this.pruneMobileClientTabSelections(belongsToHost)
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
    // Why: selected repo fields use `undefined` as an explicit clear signal, so delete them before assigning the patch.
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
      // Why: old persisted repos have no marker; stamp it on first visibility change so later hide/show keeps legacy safety.
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
    // Why: never spawn git/gh username resolution in hydration — a stuck probe froze Windows startup for minutes (issue #7225); read only cache/persisted value.
    const gitUsername = isFolderRepo(repo)
      ? ''
      : (this.gitUsernameCache.get(repo.path) ?? repo.gitUsername ?? '')

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
    // Why: retention prunes old runs, so the retained count isn't the ordinal — carry the number forward from the newest survivor.
    const runNumber = nextAutomationRunNumber(
      (this.state.automationRuns ?? []).filter((run) => run.automationId === automation.id)
    )
    const run: AutomationRun = {
      id: randomUUID(),
      automationId: automation.id,
      runNumber,
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
    this.state.automationRuns = pruneAutomationRuns([...(this.state.automationRuns ?? []), run])
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
    this.state.workspaceSession = removeWorkspaceSessionOwner(
      this.state.workspaceSession,
      worktreeId,
      { advanceTerminalTopologyRevision: true }
    )!
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
      if (session.terminalSurfaceTombstonesByPaneKey) {
        let tombstonesChanged = false
        const nextTombstones = { ...session.terminalSurfaceTombstonesByPaneKey }
        for (const [paneKey, tombstone] of Object.entries(nextTombstones)) {
          if (tombstone.worktreeId !== oldWorktreeId) {
            continue
          }
          nextTombstones[paneKey] = { ...tombstone, worktreeId: newWorktreeId }
          tombstonesChanged = true
        }
        if (tombstonesChanged) {
          session.terminalSurfaceTombstonesByPaneKey = nextTombstones
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
    // Why: children carry this as parentWorktreeId; keep the denormalized path-derived id consistent (parentWorktreeInstanceId is stable).
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
    for (const selectionsByWorktree of Object.values(
      this.state.mobileClientTabSelectionsByDeviceId ?? {}
    )) {
      changed = moveKey(selectionsByWorktree) || changed
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

  // Why: UI view-state is written from both desktop and mobile (ui.set RPC), so notify to keep bi-directional sync (desktop hydrates UI only once).
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
    // Why: coerce to boolean here (not the IPC edge) so every write path is covered and a truthy non-bool can't persist as "tray-minimize on".
    if ('minimizeToTrayOnClose' in updates) {
      sanitizedUpdates.minimizeToTrayOnClose = updates.minimizeToTrayOnClose === true
    }
    if ('showMenuBarIcon' in updates) {
      sanitizedUpdates.showMenuBarIcon = updates.showMenuBarIcon === true
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
    if ('prBotAuthorOverrides' in updates) {
      // Why: every writer (desktop IPC, web RPC, migrations) hits this boundary, so the persisted list stays bounded and well-formed.
      sanitizedUpdates.prBotAuthorOverrides = normalizePRBotAuthorOverrides(
        updates.prBotAuthorOverrides
      )
    }
    const historyWithPreviousLayout = buildWorkspaceDirHistoryForUpdate(
      this.state.settings,
      sanitizedUpdates
    )
    if (historyWithPreviousLayout) {
      sanitizedUpdates.workspaceDirHistory = historyWithPreviousLayout
    }
    // Why deep-merge telemetry: a partial update (e.g. flipping only `optedIn`) must not clobber siblings like `installId`.
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
      usagePercentageDisplay: normalizeUsagePercentageDisplay(
        this.state.ui?.usagePercentageDisplay
      ),
      statusBarUsageMode: normalizeStatusBarUsageMode(this.state.ui?.statusBarUsageMode),
      // Why: strict boolean coercion so a missing/legacy value reads as false (first-run notice still fires).
      trayMinimizeNoticeShown: this.state.ui?.trayMinimizeNoticeShown === true,
      markdownTocPanelWidth: clampMarkdownTocPanelWidth(this.state.ui?.markdownTocPanelWidth),
      visibleWorkspaceHostIds: normalizeVisibleExecutionHostIds(
        this.state.ui?.visibleWorkspaceHostIds
      ),
      workspaceHostOrder: normalizeExecutionHostOrder(this.state.ui?.workspaceHostOrder),
      manualRepoOrder: normalizeManualRepoOrder(this.state.ui?.manualRepoOrder),
      browserDefaultZoomLevel: normalizeBrowserPageZoomLevel(
        this.state.ui?.browserDefaultZoomLevel
      ),
      showDotfilesByWorktree: normalizeShowDotfilesByWorktree(
        this.state.ui?.showDotfilesByWorktree
      ),
      featureTipsSeenIds: normalizeFeatureTipIds(this.state.ui?.featureTipsSeenIds),
      contextualToursSeenIds: normalizeContextualTourIds(this.state.ui?.contextualToursSeenIds),
      featureInteractions: normalizeFeatureInteractions(this.state.ui?.featureInteractions),
      activeView: this.activeViewPreference.get()
    }
  }

  updateUI(updates: Partial<PersistedState['ui']>): void {
    const sanitizedUpdates = stripMainOwnedTelemetryMarkerFromUI(updates)
    const { activeView, ...durableUpdates } = sanitizedUpdates
    const activeViewChanged = this.activeViewPreference.set(activeView)
    if (Object.keys(durableUpdates).length === 0) {
      if (activeViewChanged) {
        this.notifyUIChanged()
      }
      return
    }
    const currentUI = {
      ...getDefaultUIState(),
      ...stripMainOwnedTelemetryMarkerFromUI(this.state.ui)
    }
    const previousUI = {
      ...this.getUI(),
      // Why: the legacy field stays unchanged as a migration/downgrade
      // fallback; the profile sidecar is authoritative in current builds.
      activeView: currentUI.activeView
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
      ...durableUpdates,
      groupBy: durableUpdates.groupBy
        ? normalizeGroupBy(durableUpdates.groupBy)
        : normalizeGroupBy(this.state.ui?.groupBy),
      sortBy: durableUpdates.sortBy
        ? normalizeSortBy(durableUpdates.sortBy)
        : normalizeSortBy(this.state.ui?.sortBy),
      projectOrderBy: updates.projectOrderBy
        ? normalizeProjectOrderBy(updates.projectOrderBy)
        : normalizeProjectOrderBy(this.state.ui?.projectOrderBy),
      activeView: currentUI.activeView,
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
      usagePercentageDisplay: normalizeUsagePercentageDisplay(
        sanitizedUpdates.usagePercentageDisplay ?? this.state.ui?.usagePercentageDisplay
      ),
      statusBarUsageMode: normalizeStatusBarUsageMode(
        sanitizedUpdates.statusBarUsageMode ?? this.state.ui?.statusBarUsageMode
      ),
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
      manualRepoOrder:
        updates.manualRepoOrder !== undefined
          ? normalizeManualRepoOrder(updates.manualRepoOrder)
          : normalizeManualRepoOrder(this.state.ui?.manualRepoOrder),
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
      // Why: renderer and paired clients can mark different tours seen from stale snapshots; union so completed tours stay suppressed.
      contextualToursSeenIds:
        updates.contextualToursSeenIds !== undefined
          ? mergeContextualTourSeenIds(
              this.state.ui?.contextualToursSeenIds,
              updates.contextualToursSeenIds
            )
          : normalizeContextualTourIds(this.state.ui?.contextualToursSeenIds),
      // Why: runtime RPCs and the renderer both record education state; merge so a stale renderer snapshot can't erase runtime-only interactions.
      featureInteractions:
        sanitizedUpdates.featureInteractions !== undefined
          ? mergeFeatureInteractions(
              this.state.ui?.featureInteractions,
              sanitizedUpdates.featureInteractions
            )
          : normalizeFeatureInteractions(this.state.ui?.featureInteractions)
    }
    if (persistedUIValuesEqual(previousUI, nextUI)) {
      if (activeViewChanged) {
        this.notifyUIChanged()
      }
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
    // Why no scheduleSave: cache is memory-only and snapshotted to a sidecar at flush; persisting here rewrote the whole state file every poll cycle.
    this.state.githubCache = cache
    this.githubCacheDirty = true
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

  private setLocalWorkspaceSession(session: PersistedState['workspaceSession']): void {
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
    const migratedScrollback = migrateWorkspaceSessionTerminalScrollbackSnapshots(
      session,
      this.terminalScrollbackSnapshotStorage
    )
    session = migratedScrollback.session
    deleteRemovedTerminalScrollbackSnapshots(prior, session, this.terminalScrollbackSnapshotStorage)
    this.state.workspaceSession = session
    this.scheduleSave()
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
    // Why: target removal is destructive; scrub matching bindings before deleting the lease, else removing the tombstone can revive stale PTY ids.
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

  // Why: sync-flush the pty binding before pty:spawn returns to close the spawn/persist SIGKILL race (Issue #217).
  persistPtyBinding(
    args: {
      worktreeId: string
      tabId: string
      leafId: string
      ptyId: string
      incarnationId?: string
      startupCwd?: string
    },
    hostId?: string | null
  ): void {
    const resolvedHostId = this.resolveHostId(hostId)
    const session = this.getWorkspaceSession(resolvedHostId)
    if (resolvedHostId !== LOCAL_EXECUTION_HOST_ID) {
      this.state.workspaceSessionsByHostId = {
        ...this.state.workspaceSessionsByHostId,
        [resolvedHostId]: session
      }
    }
    const sessionBeforeBinding = cloneWorkspaceSessionState(session)
    const paneKey = `${args.tabId}:${args.leafId}`
    let terminalMembershipChanged = false
    const advanceTopologyAfterMembershipChange = (): void => {
      const repoId = getRepoIdFromWorktreeId(args.worktreeId)
      const currentRevision = session.terminalTopologyRevisionByRepoId?.[repoId] ?? 0
      if (!terminalMembershipChanged || currentRevision <= 0) {
        return
      }
      // Why: a real host-admitted spawn after a retirement must be distinguishable from a stale renderer replay.
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
    const tabs = session.tabsByWorktree?.[args.worktreeId]
    const tab = tabs?.find((t) => t.id === args.tabId)
    if (tab) {
      tab.ptyId = args.ptyId
    } else {
      terminalMembershipChanged = true
      // Why: pty:spawn can beat the debounced writer; persist a minimal tab so hydration won't prune the binding as orphaned.
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
      // Why: keep legacy renderer-local pane ids out of durable leaf-keyed layout state after the UUID migration.
      advanceTopologyAfterMembershipChange()
      try {
        this.flushOrThrow()
      } catch (err) {
        restoreSession()
        throw err
      }
      return
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
    advanceTopologyAfterMembershipChange()
    try {
      this.flushOrThrow()
    } catch (err) {
      restoreSession()
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

  // ── Live Claude PTY sessions ───────────────────────────────────────

  getClaudeLivePtySessionIds(): string[] {
    return [...(this.state.claudeLivePtySessionIds ?? [])]
  }

  addClaudeLivePtySessionId(sessionId: string): void {
    if (sessionId.length === 0 || sessionId.length > 512) {
      return
    }
    const ids = this.state.claudeLivePtySessionIds ?? []
    if (ids.includes(sessionId)) {
      return
    }
    // Why: drop oldest at the cap — stale ids get pruned against the daemon at startup, so only recency matters.
    this.state.claudeLivePtySessionIds = [...ids, sessionId].slice(-MAX_CLAUDE_LIVE_PTY_SESSION_IDS)
    // Why: flush sync so a force-quit right after a Claude spawn still seeds the live-PTY gate next launch.
    this.flush()
  }

  removeClaudeLivePtySessionId(sessionId: string): void {
    const ids = this.state.claudeLivePtySessionIds ?? []
    if (!ids.includes(sessionId)) {
      return
    }
    this.state.claudeLivePtySessionIds = ids.filter((id) => id !== sessionId)
    this.scheduleSave()
  }

  getDeletedSshConfigAliases(): string[] {
    return [...(this.state.deletedSshConfigAliases ?? [])]
  }

  addDeletedSshConfigAlias(alias: string): void {
    this.state.deletedSshConfigAliases ??= []
    if (!this.state.deletedSshConfigAliases.includes(alias)) {
      this.state.deletedSshConfigAliases.push(alias)
      this.scheduleSave()
    }
  }

  removeDeletedSshConfigAlias(alias: string): void {
    const current = this.state.deletedSshConfigAliases
    if (!current || !current.includes(alias)) {
      return
    }
    this.state.deletedSshConfigAliases = current.filter((entry) => entry !== alias)
    this.scheduleSave()
  }

  clearDeletedSshConfigAliases(): void {
    if (this.state.deletedSshConfigAliases && this.state.deletedSshConfigAliases.length > 0) {
      this.state.deletedSshConfigAliases = []
      this.scheduleSave()
    }
  }

  getRemovedSshTargetTombstones(): RemovedSshTargetTombstone[] {
    return [...(this.state.removedSshTargetTombstones ?? [])]
  }

  addRemovedSshTargetTombstone(tombstone: RemovedSshTargetTombstone): void {
    const existing = this.state.removedSshTargetTombstones ?? []
    // Why: dedupe by oldTargetId so re-removing the same id can't stack duplicate tombstones; newest wins.
    const filtered = existing.filter((t) => t.oldTargetId !== tombstone.oldTargetId)
    // Cap the history so pathological churn can't grow the state file unbounded.
    this.state.removedSshTargetTombstones = [...filtered, tombstone].slice(
      -MAX_REMOVED_SSH_TARGET_TOMBSTONES
    )
    this.scheduleSave()
  }

  removeRemovedSshTargetTombstone(oldTargetId: string): void {
    const existing = this.state.removedSshTargetTombstones
    if (!existing?.some((t) => t.oldTargetId === oldTargetId)) {
      return
    }
    this.state.removedSshTargetTombstones = existing.filter((t) => t.oldTargetId !== oldTargetId)
    this.scheduleSave()
  }

  /**
   * Re-point every repo and worktree meta pinned to a removed SSH target id onto
   * a re-added target's id so orphaned workspaces reattach. Returns re-pointed repo ids.
   */
  reassignSshTargetId(oldTargetId: string, newTargetId: string): string[] {
    if (oldTargetId === newTargetId) {
      return []
    }
    const oldHostId = toSshExecutionHostId(oldTargetId)
    const newHostId = toSshExecutionHostId(newTargetId)
    const repoIds = new Set<string>()
    for (const repo of this.state.repos) {
      const matchesConnection = repo.connectionId === oldTargetId
      const matchesHost = repo.executionHostId === oldHostId
      if (!matchesConnection && !matchesHost) {
        continue
      }
      if (matchesConnection) {
        repo.connectionId = newTargetId
      }
      // Why: don't stamp executionHostId where it was unset — addRemoteRepoFromPath repos derive the host from connectionId.
      if (matchesHost) {
        repo.executionHostId = newHostId
      }
      repoIds.add(repo.id)
    }
    // Re-point worktree metas whose hostId pointed at the old SSH host.
    let metaChanged = false
    for (const meta of Object.values(this.state.worktreeMeta)) {
      if (meta.hostId === oldHostId) {
        meta.hostId = newHostId
        metaChanged = true
      }
    }
    // Why: any carrier still holding the old id later throws `SSH target not found` (STA-1468); migrate them all.
    let carrierChanged = migrateWorkspaceSessionSshTargetId(
      this.state.workspaceSession,
      oldTargetId,
      newTargetId
    )
    for (const session of Object.values(this.state.workspaceSessionsByHostId ?? {})) {
      if (session && migrateWorkspaceSessionSshTargetId(session, oldTargetId, newTargetId)) {
        carrierChanged = true
      }
    }
    // Why: partitions are read by host id; re-key from the removed id to the new one (keep new if it already exists).
    const partitions = this.state.workspaceSessionsByHostId
    const oldPartition = partitions?.[oldHostId]
    if (partitions && oldPartition) {
      delete partitions[oldHostId]
      partitions[newHostId] ??= oldPartition
      carrierChanged = true
    }
    if (migrateUiHostScopeSshTargetId(this.state.ui, oldTargetId, newTargetId)) {
      carrierChanged = true
    }
    for (const lease of this.state.sshRemotePtyLeases ?? []) {
      if (lease.targetId === oldTargetId) {
        lease.targetId = newTargetId
        carrierChanged = true
      }
    }
    let setupsChanged = false
    const keptSetups: ProjectHostSetup[] = []
    for (const setup of this.state.projectHostSetups) {
      if (setup.hostId !== oldHostId) {
        keptSetups.push(setup)
        continue
      }
      const duplicate = this.state.projectHostSetups.some(
        (entry) =>
          entry !== setup && entry.projectId === setup.projectId && entry.hostId === newHostId
      )
      // Why: drop the old ghost row that would violate (projectId, hostId) uniqueness with the re-added host's setup.
      if (duplicate) {
        setupsChanged = true
        continue
      }
      setup.hostId = newHostId
      setup.updatedAt = Date.now()
      keptSetups.push(setup)
      setupsChanged = true
    }
    if (setupsChanged) {
      this.state.projectHostSetups = keptSetups
    }
    // Why: repo-row and host-setup rewrites affect host-setup compatibility; meta-only rewrites don't, so gate the sync here.
    if (repoIds.size > 0 || setupsChanged) {
      this.syncProjectHostSetupCompatibilityState()
    }
    if (repoIds.size > 0 || metaChanged || carrierChanged || setupsChanged) {
      this.scheduleSave()
    }
    return [...repoIds]
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
    // Why: store target-local pty ids in leases so reconnect can call relay pty.attach with raw ids (app ids are global).
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
    if (!leases?.length) {
      return false
    }
    let changed = false
    const sessions = new Set(
      [
        this.state.workspaceSession,
        this.state.workspaceSessionsByHostId?.[toSshExecutionHostId(targetId)]
      ].filter((session): session is WorkspaceSessionState => Boolean(session))
    )
    for (const session of sessions) {
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
    try {
      this.flushActiveViewPreferenceOrThrow()
    } catch (err) {
      console.error('[active-view] Failed to flush preference:', err)
    }
    this.writeGithubCacheSnapshotSync()
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
    const cacheFile = getGithubCacheFile(this.dataFile)
    const tmpFile = `${cacheFile}.${process.pid}.tmp`
    try {
      writeFileSync(tmpFile, JSON.stringify(this.state.githubCache), 'utf-8')
      renameSync(tmpFile, cacheFile)
      this.githubCacheDirty = false
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
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: Date.now(),
    lastActivityAt: 0,
    workspaceStatus: DEFAULT_WORKSPACE_STATUS_ID
  }
}
