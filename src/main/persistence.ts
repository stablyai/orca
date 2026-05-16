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
  statSync
} from 'fs'
import { writeFile, rename, mkdir, rm, copyFile } from 'fs/promises'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'node:crypto'
import type {
  Automation,
  AutomationCreateInput,
  AutomationDispatchResult,
  AutomationRun,
  AutomationRunTrigger,
  AutomationUpdateInput
} from '../shared/automations-types'
import {
  latestAutomationOccurrenceAtOrBefore,
  nextAutomationOccurrenceAfter
} from '../shared/automation-schedules'
import type {
  PersistedState,
  Repo,
  SparsePreset,
  WorktreeMeta,
  WorktreeLineage,
  GlobalSettings,
  OnboardingChecklistState,
  OnboardingOutcome,
  OnboardingState,
  LegacyPaneKeyAliasEntry,
  TerminalPaneLayoutNode,
  TerminalLayoutSnapshot,
  TerminalTab,
  WorkspaceSessionState
} from '../shared/types'
import type { MigrationUnsupportedPtyEntry } from '../shared/agent-status-types'
import type { SshRemotePtyLease, SshTarget } from '../shared/ssh-types'
import { isFolderRepo } from '../shared/repo-kind'
import { getGitUsername } from './git/repo'
import {
  getDefaultPersistedState,
  getDefaultNotificationSettings,
  getDefaultOnboardingState,
  getDefaultVoiceSettings,
  getDefaultUIState,
  getDefaultRepoHookSettings,
  getDefaultWorkspaceSession,
  ONBOARDING_FINAL_STEP
} from '../shared/constants'
import { parseWorkspaceSession } from '../shared/workspace-session-schema'
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
import { getRepoIdFromWorktreeId } from '../shared/worktree-id'
import { normalizeTerminalQuickCommands } from '../shared/terminal-quick-commands'
import { normalizeVisibleTaskProviders } from '../shared/task-providers'
import {
  DEFAULT_WORKSPACE_STATUS_ID,
  clampWorkspaceBoardOpacity,
  normalizeWorkspaceBoardCompact,
  normalizeWorkspaceStatuses
} from '../shared/workspace-statuses'

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

export function initDataPath(): void {
  _dataFile = join(app.getPath('userData'), 'orca-data.json')
}

function getDataFile(): string {
  if (!_dataFile) {
    // Safety fallback — should not be hit in normal startup.
    _dataFile = join(app.getPath('userData'), 'orca-data.json')
  }
  return _dataFile
}

// Why (issue #1158): keep 5 rolling backups of orca-data.json so a corrupt or
// empty write leaves at least one earlier copy recoverable. Five snapshots at
// >=1-hour spacing cover recent work without churning disk on every debounce.
const BACKUP_COUNT = 5
const BACKUP_MIN_INTERVAL_MS = 60 * 60 * 1000

function backupPath(dataFile: string, index: number): string {
  return `${dataFile}.bak.${index}`
}

function normalizeGroupBy(groupBy: unknown): PersistedState['ui']['groupBy'] {
  if (groupBy === 'none' || groupBy === 'repo' || groupBy === 'pr-status') {
    return groupBy
  }
  if (groupBy === 'workspace-status') {
    return 'none'
  }
  return getDefaultUIState().groupBy
}

function normalizeSortBy(sortBy: unknown): 'name' | 'smart' | 'recent' | 'repo' {
  if (sortBy === 'smart' || sortBy === 'recent' || sortBy === 'repo' || sortBy === 'name') {
    return sortBy
  }
  return getDefaultUIState().sortBy
}

// Why: old persisted targets predate configHost. Default to label-based lookup
// so imported SSH aliases keep resolving through ssh -G after upgrade.
function normalizeSshTarget(t: SshTarget): SshTarget {
  return { ...t, configHost: t.configHost ?? t.label ?? t.host }
}

// Why: shared by load-time merge and the IPC update handler so the same
// strict whitelist guards every entry into onboarding state — arbitrary
// renderer/disk input cannot inject unknown keys or wrong-typed values.
// Returns only validated fields; unknown keys are dropped silently.
// Why: returns Partial<...> with a partial checklist so the IPC update path
// merges over current state without wiping previously-true keys. Invalid
// top-level fields are OMITTED (not coerced to fallbacks) so partial updates
// don't clobber valid persisted state; the load-path caller spreads defaults.
export function sanitizeOnboardingUpdate(
  input: unknown
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
  if ('lastCompletedStep' in raw) {
    const v = raw.lastCompletedStep
    if (typeof v === 'number' && Number.isInteger(v) && v >= -1 && v <= ONBOARDING_FINAL_STEP) {
      out.lastCompletedStep = v
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
  return out
}

// Why: read a settings field that was removed from the GlobalSettings type
// but still round-trips on disk via the ...parsed.settings spread. One-shot
// use only — for the inline-agents default-on migration's Case B discriminator.
// Delete with the migration in the cleanup release (2+ stable releases after
// _inlineAgentsDefaultedForAllUsers ships).
function readDeprecatedExperimentFlag(parsed: PersistedState | undefined): boolean {
  return (
    (parsed?.settings as { experimentalAgentDashboard?: boolean } | undefined)
      ?.experimentalAgentDashboard === true
  )
}

function readLegacySidekickFlag(parsed: PersistedState | undefined): boolean | undefined {
  return (parsed?.settings as { experimentalSidekick?: boolean } | undefined)?.experimentalSidekick
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
  const titlesByLeafId = remapLeafRecordForPersistence(
    inputSnapshot.titlesByLeafId,
    leafIdByInputLeafId,
    duplicatedInputLeafIds
  )
  const recordsChanged =
    !leafRecordEquivalent(inputSnapshot.ptyIdsByLeafId, ptyIdsByLeafId) ||
    !leafRecordEquivalent(inputSnapshot.buffersByLeafId, buffersByLeafId) ||
    !leafRecordEquivalent(inputSnapshot.titlesByLeafId, titlesByLeafId)
  const metadataChanged =
    activeLeafId !== inputSnapshot.activeLeafId || expandedLeafId !== inputSnapshot.expandedLeafId
  if (!changed && !recordsChanged && !metadataChanged) {
    return { snapshot, changed: false, leafIdByInputLeafId }
  }
  const {
    ptyIdsByLeafId: _oldPtyIdsByLeafId,
    buffersByLeafId: _oldBuffersByLeafId,
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
    migrationUnsupportedEntries.push(...migrationEntries.migrationUnsupportedEntries)
    legacyPaneKeyAliasEntries.push(...migrationEntries.legacyPaneKeyAliasEntries)
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

export class Store {
  private state: PersistedState
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  private pendingWrite: Promise<void> | null = null
  private writeGeneration = 0
  private gitUsernameCache = new Map<string, string>()

  constructor() {
    const loaded = this.load()
    const normalized = normalizePersistedPaneIdentityState(loaded)
    this.state = normalized.state
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
    if (normalized.changed) {
      // Why: upgraded sessions may contain legacy pane:1 leaves. Rewrite them at
      // the main persistence boundary so older renderer writes cannot revive them.
      this.scheduleSave()
    }
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

    let result: PersistedState | null = null
    try {
      if (fileExistedOnLoad) {
        const raw = readFileSync(dataFile, 'utf-8')
        const parsed = JSON.parse(raw) as PersistedState

        // Why: opencodeSessionCookie is stored encrypted on disk via safeStorage.
        // Decrypt at the load boundary so the rest of the app sees plaintext.
        if (parsed.settings?.opencodeSessionCookie) {
          parsed.settings.opencodeSessionCookie = decrypt(parsed.settings.opencodeSessionCookie)
        }
        if (parsed.ui?.browserKagiSessionLink) {
          parsed.ui.browserKagiSessionLink = decryptOptionalSecret(parsed.ui.browserKagiSessionLink)
        }

        // Merge with defaults in case new fields were added
        const defaults = getDefaultPersistedState(homedir())
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
        result = {
          ...defaults,
          ...parsed,
          worktreeLineageById: parsed.worktreeLineageById ?? {},
          settings: {
            ...defaults.settings,
            ...parsed.settings,
            // Why: v1.3.42 renamed the cosmetic sidekick setting to pet. Carry
            // the old persisted flag forward once so enabled users don't lose it.
            experimentalPet:
              parsed.settings?.experimentalPet ?? readLegacySidekickFlag(parsed) ?? false,
            // Why: Activity graduated from its experimental gate. Force the
            // legacy flag on so existing profiles and rollback builds see the
            // same default-on behavior as fresh installs.
            experimentalActivity: true,
            terminalMacOptionAsAlt: migratedOptionAsAlt,
            terminalMacOptionAsAltMigrated: true,
            floatingTerminalEnabled: migratedFloatingTerminalEnabled,
            floatingTerminalDefaultedForAllUsers: true,
            terminalQuickCommands: normalizeTerminalQuickCommands(
              parsed.settings?.terminalQuickCommands
            ),
            visibleTaskProviders: normalizeVisibleTaskProviders(
              parsed.settings?.visibleTaskProviders
            ),
            notifications: {
              ...getDefaultNotificationSettings(),
              ...parsed.settings?.notifications
            },
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
            // Why: the 'inline-agents' card property was added after the
            // feature shipped behind an experimental toggle. Now that the
            // feature is default-on for everyone, every existing user needs
            // 'inline-agents' appended to their persisted
            // worktreeCardProperties on first load after upgrade so the
            // inline agent rows render without further opt-in. A flag
            // prevents re-firing so a deliberate uncheck from the Workspaces
            // view options menu sticks across restarts.
            //
            // TRAP — do not key this on `_inlineAgentsDefaultedForExperiment`.
            // That legacy flag was stamped unconditionally on every successful
            // load() in prior builds, regardless of whether the experiment was
            // toggled on. Every prior-RC user therefore already has it set to
            // true on disk, including the opt-out cohort this widened
            // migration was specifically written to reach. Gating on the
            // legacy flag would silently skip exactly those users. The
            // dedicated `_inlineAgentsDefaultedForAllUsers` flag exists so
            // the new default-on migration can distinguish "already migrated
            // under the new rules" from "happened to launch a prior build".
            //
            // Case B preservation: a user who turned the experiment on and then
            // deliberately unchecked 'inline-agents' from the sidebar options
            // menu has the same on-disk shape as a never-touched user. The
            // discriminator below reads the deprecated `experimentalAgentDashboard`
            // value as a one-shot signal. Both branches of the migration stamp
            // `_inlineAgentsDefaultedForAllUsers`, so subsequent launches don't
            // depend on the deprecated value continuing to round-trip.
            const rawCardProps = parsed.ui?.worktreeCardProperties
            const inlineAgentsMigrated = parsed.ui?._inlineAgentsDefaultedForAllUsers === true
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
            const migratedCardProps =
              needsInlineAgentsMigration && Array.isArray(rawCardProps)
                ? [...rawCardProps, 'inline-agents' as const]
                : undefined
            return {
              ...defaults.ui,
              ...parsed.ui,
              sortBy: migrate ? ('smart' as const) : sort,
              _sortBySmartMigrated: true,
              ...(migratedCardProps !== undefined
                ? { worktreeCardProperties: migratedCardProps }
                : {}),
              // Why: keep stamping the legacy flag for forward-compat with
              // a rollback to a pre-default-on build that still reads it.
              // The new flag is the one that actually gates the migration.
              _inlineAgentsDefaultedForExperiment: true,
              _inlineAgentsDefaultedForAllUsers: true
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
          onboarding: (() => {
            // Why: if we successfully parsed an existing orca-data.json that
            // lacks an onboarding block, this is an upgrade-cohort user —
            // backfill as completed (not dismissed) so they don't get dropped
            // into the wizard regardless of whether they currently have repos,
            // SSH targets, or just non-default settings. Analytics still
            // distinguish this from users who explicitly bailed mid-funnel.
            if (!parsed.onboarding) {
              return {
                ...defaults.onboarding,
                closedAt: Date.now(),
                outcome: 'completed' as const,
                lastCompletedStep: ONBOARDING_FINAL_STEP
              }
            }
            // Why: validate every persisted onboarding key explicitly via the
            // shared sanitizer instead of spreading raw values. A type-flipped
            // field on disk (string where number expected, unknown checklist
            // key) is dropped or coerced to the default rather than poisoning
            // in-memory state.
            const sanitized = sanitizeOnboardingUpdate(parsed.onboarding)
            return {
              ...defaults.onboarding,
              ...sanitized,
              checklist: {
                ...defaults.onboarding.checklist,
                ...sanitized.checklist
              }
            }
          })()
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
      result = getDefaultPersistedState(homedir())
    }

    result = {
      ...result,
      workspaceSession: pruneWorkspaceSessionBrowserHistory(
        pruneLocalTerminalScrollbackBuffers(result.workspaceSession, result.repos)
      )
    }

    return this.migrateTelemetry(result, fileExistedOnLoad)
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

  private scheduleSave(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
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
    }, 300)
  }

  /** Wait for any in-flight async disk write to complete. Used in tests. */
  async waitForPendingWrite(): Promise<void> {
    if (this.pendingWrite) {
      await this.pendingWrite
    }
  }

  // Why: async writes avoid blocking the main Electron thread on every
  // debounced save (every 300ms during active use).
  private async writeToDiskAsync(): Promise<void> {
    const gen = this.writeGeneration
    const dataFile = getDataFile()
    const dir = dirname(dataFile)
    await mkdir(dir, { recursive: true }).catch(() => {})
    const tmpFile = `${dataFile}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`

    // Why: opencodeSessionCookie must be encrypted on disk. Clone state so
    // the in-memory this.state stays plaintext for the rest of the app.
    const stateToSave = {
      ...this.state,
      settings: {
        ...this.state.settings,
        opencodeSessionCookie: encrypt(this.state.settings.opencodeSessionCookie)
      },
      ui: {
        ...this.state.ui,
        browserKagiSessionLink: encryptOptionalSecret(this.state.ui.browserKagiSessionLink)
      }
    }

    // Why: wrap write+rename in try/finally-on-error so any failure (ENOSPC,
    // ENFILE, EIO, permission) removes the tmp file rather than leaving a
    // multi-megabyte orphan behind. Successful rename consumes the tmp file.
    let renamed = false
    try {
      await writeFile(tmpFile, JSON.stringify(stateToSave, null, 2), 'utf-8')
      // Why: if flush() ran while this async write was in-flight, it bumped
      // writeGeneration and already wrote the latest state synchronously.
      // Renaming this stale tmp file would overwrite the fresh data.
      if (this.writeGeneration !== gen) {
        return
      }
      await rename(tmpFile, dataFile)
      renamed = true
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
  private writeToDiskSync(): void {
    const dataFile = getDataFile()
    const dir = dirname(dataFile)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    const tmpFile = `${dataFile}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`

    // Why: opencodeSessionCookie must be encrypted on disk. Clone state so
    // the in-memory this.state stays plaintext for the rest of the app.
    const stateToSave = {
      ...this.state,
      settings: {
        ...this.state.settings,
        opencodeSessionCookie: encrypt(this.state.settings.opencodeSessionCookie)
      },
      ui: {
        ...this.state.ui,
        browserKagiSessionLink: encryptOptionalSecret(this.state.ui.browserKagiSessionLink)
      }
    }

    // Why: mirror the async path — on any failure between writeFileSync and
    // renameSync, remove the tmp file so crashes during shutdown don't leak
    // orphans into userData.
    let renamed = false
    try {
      writeFileSync(tmpFile, JSON.stringify(stateToSave, null, 2), 'utf-8')
      renameSync(tmpFile, dataFile)
      renamed = true
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
    // Why: bump writeGeneration so any in-flight async writeToDiskAsync skips
    // its rename, preventing a stale snapshot from overwriting this sync write.
    this.writeGeneration++
    this.pendingWrite = null
    this.writeToDiskSync()
  }

  // ── Repos ──────────────────────────────────────────────────────────

  getRepos(): Repo[] {
    return this.state.repos.map((repo) => this.hydrateRepo(repo))
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

  addRepo(repo: Repo): void {
    this.state.repos.push(repo)
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
    this.scheduleSave()
    return true
  }

  removeRepo(id: string): void {
    this.state.repos = this.state.repos.filter((r) => r.id !== id)
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
    this.scheduleSave()
  }

  updateRepo(
    id: string,
    updates: Partial<
      Pick<
        Repo,
        | 'displayName'
        | 'badgeColor'
        | 'hookSettings'
        | 'worktreeBaseRef'
        | 'kind'
        | 'issueSourcePreference'
      >
    >
  ): Repo | null {
    const repo = this.state.repos.find((r) => r.id === id)
    if (!repo) {
      return null
    }
    // Why: `issueSourcePreference === undefined` in the patch means "reset to
    // auto" (and the persisted record should drop the key, not preserve a
    // stale explicit value via Object.assign's skip-on-undefined behavior).
    // Without this delete branch, toggling explicit → auto would silently
    // leave the old preference in place on disk.
    if ('issueSourcePreference' in updates && updates.issueSourcePreference === undefined) {
      delete repo.issueSourcePreference
      const { issueSourcePreference: _drop, ...rest } = updates
      Object.assign(repo, rest)
    } else {
      Object.assign(repo, updates)
    }
    this.scheduleSave()
    return this.hydrateRepo(repo)
  }

  private hydrateRepo(repo: Repo): Repo {
    const gitUsername = isFolderRepo(repo)
      ? ''
      : (this.gitUsernameCache.get(repo.path) ??
        (() => {
          const username = getGitUsername(repo.path)
          this.gitUsernameCache.set(repo.path, username)
          return username
        })())

    return {
      ...repo,
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
    return [...(this.state.automations ?? [])].sort((left, right) =>
      left.name.localeCompare(right.name)
    )
  }

  listAutomationRuns(automationId?: string): AutomationRun[] {
    const runs = this.state.automationRuns ?? []
    return [
      ...(automationId ? runs.filter((run) => run.automationId === automationId) : runs)
    ].sort((left, right) => right.createdAt - left.createdAt)
  }

  createAutomation(input: AutomationCreateInput): Automation {
    const repo = this.state.repos.find((entry) => entry.id === input.projectId)
    const now = Date.now()
    const executionTargetType = repo?.connectionId ? 'ssh' : 'local'
    const automation: Automation = {
      id: randomUUID(),
      name: input.name.trim() || 'Untitled automation',
      prompt: input.prompt,
      agentId: input.agentId,
      projectId: input.projectId,
      executionTargetType,
      executionTargetId: executionTargetType === 'ssh' ? (repo?.connectionId ?? '') : 'local',
      schedulerOwner: executionTargetType === 'ssh' ? 'ssh_bridge' : 'local_host_service',
      workspaceMode: input.workspaceMode,
      workspaceId: input.workspaceMode === 'existing' ? (input.workspaceId ?? null) : null,
      baseBranch: input.workspaceMode === 'new_per_run' ? (input.baseBranch ?? null) : null,
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
    const rrule = updates.rrule ?? current.rrule
    const dtstart = updates.dtstart ?? current.dtstart
    const scheduleChanged = updates.rrule !== undefined || updates.dtstart !== undefined
    const workspaceMode = updates.workspaceMode ?? current.workspaceMode
    const updated: Automation = {
      ...current,
      ...updates,
      name:
        updates.name !== undefined ? updates.name.trim() || 'Untitled automation' : current.name,
      projectId: repoId,
      executionTargetType,
      executionTargetId: executionTargetType === 'ssh' ? (repo?.connectionId ?? '') : 'local',
      schedulerOwner: executionTargetType === 'ssh' ? 'ssh_bridge' : 'local_host_service',
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
      title: `${automation.name} run ${runNumber}`,
      scheduledFor,
      status: 'pending',
      trigger,
      workspaceId: automation.workspaceId,
      sessionKind: 'terminal',
      chatSessionId: null,
      terminalSessionId: null,
      usage: null,
      error: null,
      startedAt: null,
      dispatchedAt: null,
      createdAt: now
    }
    this.state.automationRuns = [...(this.state.automationRuns ?? []), run]
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
    const updated: AutomationRun = {
      ...current,
      status: result.status,
      workspaceId: result.workspaceId ?? current.workspaceId,
      terminalSessionId: result.terminalSessionId ?? current.terminalSessionId,
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

  // ── Settings ───────────────────────────────────────────────────────

  getSettings(): GlobalSettings {
    return this.state.settings
  }

  updateSettings(updates: Partial<GlobalSettings>): GlobalSettings {
    const sanitizedUpdates = { ...updates }
    if ('terminalQuickCommands' in updates) {
      sanitizedUpdates.terminalQuickCommands = normalizeTerminalQuickCommands(
        updates.terminalQuickCommands
      )
    }
    if ('visibleTaskProviders' in updates) {
      sanitizedUpdates.visibleTaskProviders = normalizeVisibleTaskProviders(
        updates.visibleTaskProviders
      )
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
    this.state.settings = {
      ...this.state.settings,
      ...sanitizedUpdates,
      notifications: {
        ...this.state.settings.notifications,
        ...sanitizedUpdates.notifications
      },
      ...(mergedTelemetry !== undefined ? { telemetry: mergedTelemetry } : {})
    }
    this.scheduleSave()
    return this.state.settings
  }

  // ── UI State ───────────────────────────────────────────────────────

  getUI(): PersistedState['ui'] {
    return {
      ...getDefaultUIState(),
      ...this.state.ui,
      groupBy: normalizeGroupBy(this.state.ui?.groupBy),
      sortBy: normalizeSortBy(this.state.ui?.sortBy),
      workspaceStatuses: normalizeWorkspaceStatuses(this.state.ui?.workspaceStatuses),
      workspaceBoardOpacity: clampWorkspaceBoardOpacity(this.state.ui?.workspaceBoardOpacity),
      workspaceBoardCompact: normalizeWorkspaceBoardCompact(this.state.ui?.workspaceBoardCompact)
    }
  }

  updateUI(updates: Partial<PersistedState['ui']>): void {
    this.state.ui = {
      ...this.state.ui,
      ...updates,
      groupBy: updates.groupBy
        ? normalizeGroupBy(updates.groupBy)
        : normalizeGroupBy(this.state.ui?.groupBy),
      sortBy: updates.sortBy
        ? normalizeSortBy(updates.sortBy)
        : normalizeSortBy(this.state.ui?.sortBy),
      workspaceStatuses: normalizeWorkspaceStatuses(
        updates.workspaceStatuses ?? this.state.ui?.workspaceStatuses
      ),
      workspaceBoardOpacity: clampWorkspaceBoardOpacity(
        updates.workspaceBoardOpacity ?? this.state.ui?.workspaceBoardOpacity
      ),
      workspaceBoardCompact: normalizeWorkspaceBoardCompact(
        updates.workspaceBoardCompact ?? this.state.ui?.workspaceBoardCompact
      )
    }
    this.scheduleSave()
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

  getWorkspaceSession(): PersistedState['workspaceSession'] {
    return this.state.workspaceSession ?? getDefaultWorkspaceSession()
  }

  setWorkspaceSession(session: PersistedState['workspaceSession']): void {
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
          const titlesByLeafId = preserveMissingLeafRecordEntries(
            priorLayout.titlesByLeafId,
            layout.titlesByLeafId,
            liveLeafIds
          )
          if (buffersByLeafId) {
            layout.buffersByLeafId = buffersByLeafId
          }
          if (titlesByLeafId) {
            layout.titlesByLeafId = titlesByLeafId
          }
        }
      }
    }
    this.state.workspaceSession = session
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
    if (lease.ptyId !== binding.ptyId) {
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
    if (lease.targetId !== binding.targetId || lease.ptyId !== binding.ptyId) {
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
    Object.assign(target, updates, normalizeSshTarget({ ...target, ...updates }))
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
    this.state.sshRemotePtyLeases ??= []
    for (const lease of this.state.sshRemotePtyLeases) {
      if (lease.targetId !== targetId || lease.state === state) {
        continue
      }
      if (state === 'detached' && lease.state !== 'attached') {
        continue
      }
      lease.state = state
      lease.updatedAt = now
      if (state === 'attached') {
        lease.lastAttachedAt = now
      } else if (state === 'detached') {
        lease.lastDetachedAt = now
      }
      changed = true
    }
    if (changed) {
      this.flush()
    }
  }

  markSshRemotePtyLease(targetId: string, ptyId: string, state: SshRemotePtyLease['state']): void {
    const lease = this.state.sshRemotePtyLeases?.find(
      (entry) => entry.targetId === targetId && entry.ptyId === ptyId
    )
    if (!lease || lease.state === state) {
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
    this.flush()
  }

  removeSshRemotePtyLease(targetId: string, ptyId: string): void {
    const leases = (this.state.sshRemotePtyLeases ?? []).filter(
      (lease) => lease.targetId === targetId && lease.ptyId === ptyId
    )
    const before = this.state.sshRemotePtyLeases?.length ?? 0
    this.clearSshRemotePtyBindingsForLeases(targetId, leases)
    this.state.sshRemotePtyLeases = (this.state.sshRemotePtyLeases ?? []).filter(
      (lease) => lease.targetId !== targetId || lease.ptyId !== ptyId
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

  private clearSshRemotePtyBindingsForLeases(targetId: string, leases: SshRemotePtyLease[]): void {
    const session = this.state.workspaceSession
    if (!leases?.length || !session) {
      return
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
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: Date.now(),
    lastActivityAt: 0,
    workspaceStatus: DEFAULT_WORKSPACE_STATUS_ID
  }
}
