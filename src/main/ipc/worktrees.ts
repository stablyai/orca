/* oxlint-disable max-lines */
import { ipcMain, type BrowserWindow } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { Store } from '../persistence'
import { isFolderRepo } from '../../shared/repo-kind'
import { readBranchRenameFailureOutputForDisplay } from '../agent-hooks/branch-rename-failure-output'
import {
  isWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../shared/workspace-scope'
import { inspectSetupScriptImportCandidates } from '../../shared/setup-script-imports'
import { getProjectHostSetupWorktreeMeta } from '../../shared/project-host-setup-projection'
import { TaskSourceContextSchema } from '../../shared/task-source-context-schema'
import { WorkspaceLinkedItemSchema } from '../../shared/workspace-linked-item-schema'
import { isWorkspaceLinkedItemSourceContextMatch } from '../../shared/workspace-linked-item-source-context'
import { getProjectGroupSubtreeIds } from '../../shared/project-groups'
import { projectResolvedWorktreeLineage } from '../../shared/resolved-worktree-lineage'
import { isPathInsideOrEqual, isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { deleteWorktreeHistoryDir } from '../terminal-history-deletion'
import type {
  AutomationWorkspaceProvenance,
  CliWorkspaceProvenance,
  CreateWorktreeArgs,
  CreateWorktreeResult,
  DetectedWorktree,
  DetectedWorktreeListResult,
  ForceDeleteWorktreeBranchResult,
  GitHubPrStartPoint,
  GitPushTarget,
  GitWorktreeInfo,
  OrcaHooks,
  Repo,
  RemoveWorktreeResult,
  Worktree,
  WorktreeLineage,
  WorkspaceLineage,
  WorktreeMeta
} from '../../shared/types'
import { assertWorktreeUnlockedForRemoval } from '../../shared/worktree-removal'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import {
  PROVIDER_REQUEST_ID_MAX_UTF8_BYTES,
  type DirectSshDetectedWorktreeRequest,
  type HostQualifiedDetectedWorktreeResult,
  type ListDetectedWorktreesArgs,
  type ProviderRequestId
} from '../../shared/detected-worktree-provider-contract'
import type {
  HostLineageSnapshot,
  ListDesktopLineageForHostArgs
} from '../../shared/host-lineage-contract'
import { isAdmissibleDirectSshAuthority } from '../../shared/ssh-retained-payload-admission'
import {
  applyMetadataFallbackVisibility,
  buildKnownOrcaWorkspaceLayouts,
  isLegacyRepoForExternalWorktreeVisibility,
  toDetectedWorktree
} from '../../shared/worktree-ownership'
import { createAgentScratchWorktreePathMatcher } from '../../shared/agent-scratch-worktrees'
import {
  assertWorktreeCleanForRemoval,
  forceDeleteLocalBranch,
  listWorktreesStrict as listGitWorktreesStrict,
  removeWorktree
} from '../git/worktree'
import { gitExecFileAsync } from '../git/runner'
import { withWorktreeRemoveStageSpan, withWorktreeSpan } from '../observability/instrumentation'
import { resolveGitHubPrStartPoint } from '../github/pr-start-point'
import {
  fetchGitHubPullRequestHeadRef,
  fetchPrHeadTrackingRef
} from '../github/pr-head-tracking-ref'
import { pruneWorktreePRRefreshAliases } from '../github/pr-refresh-coordinator'
import { resolveGitHubReviewHeadRemote } from '../github/review-head-remote'
import { listRepoWorktrees } from '../repo-worktrees'
import { getSshGitProvider, requireSshGitProvider } from '../providers/ssh-git-dispatch'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import {
  createIssueCommandRunnerScript,
  getEffectiveHooks,
  getEffectiveHooksFromConfig,
  getSetupRunnerEnvVars,
  loadHooks,
  parseOrcaYaml,
  readIssueCommand,
  resolveSetupRunnerShell,
  runHook,
  hasHooksFile,
  hasUnrecognizedOrcaYamlKeys,
  writeIssueCommand
} from '../hooks'
import {
  mergeWorktree,
  parseWorktreeId,
  areWorktreePathsEqual,
  formatWorktreeRemovalError,
  isOrphanCompatiblePreflightError,
  isOrphanedWorktreeError
} from './worktree-logic'
import { dedupeWorktreesByPath } from './worktree-path-comparison'
import { joinWorktreeRelativePath } from '../runtime/runtime-relative-paths'
import {
  createLocalWorktree,
  createRemoteWorktree,
  cleanupUnusedWorktreePushTargetRemote,
  cleanupUnusedWorktreePushTargetRemoteSsh,
  notifyWorktreesChanged
} from './worktree-remote'
import { registerWorktreeChangeInvalidator } from './worktree-change-invalidators'
import {
  invalidateAuthorizedRootsCache,
  isENOENT,
  registerWorktreeRootsForRepo
} from './filesystem-auth'
import type { OrcaRuntimeService, RuntimeWorktreeLifecycleEvent } from '../runtime/orca-runtime'
import { killAllProcessesForWorktree } from '../runtime/worktree-teardown'
import { clearProviderPtyState, getLocalPtyProvider, getSshPtyProvider } from './pty'
import { findExistingWorktreeSymlinkPaths, removeWorktreeLinkedPaths } from './worktree-symlinks'
import { getWorktreeSharedLinkPaths } from '../git/worktree-shared-directories'
import { track } from '../telemetry/client'
import { getCohortAtEmit } from '../telemetry/cohort-classifier'
import { workspaceSourceSchema, type WorkspaceSource } from '../../shared/telemetry-events'
import {
  finishAutomationWorkspaceProvenanceRequest,
  releaseAutomationWorkspaceProvenanceRequest,
  resolveAutomationWorkspaceProvenance
} from '../automations/workspace-provenance'
import { shouldEmitBoundedWarning } from './bounded-warning-dedupe'
import {
  getSshProviderAuthority,
  isCurrentSshProviderAuthority,
  registerSshProviderRequestAbort
} from '../ssh/ssh-provider-authority'
import { createSenderScopedRequestCancellations } from './sender-scoped-request-cancellation'

type CreateWorktreeArgsWithSystemProvenance = CreateWorktreeArgs & {
  automationProvenance?: AutomationWorkspaceProvenance
  cliProvenance?: CliWorkspaceProvenance
}

type RemoveWorktreeArgs = {
  worktreeId: string
  hostId?: ExecutionHostId
  force?: boolean
  /** Explicit Force Delete only — `force` alone is set by the ordinary confirmation (#11960). */
  allowUnverifiedPtyStop?: boolean
  skipArchive?: boolean
}

type DetectedWorktreeRequestArgs = { repoId: string } | ListDetectedWorktreesArgs

async function stopPtysForDestructiveWorktreeRemoval(
  runtime: OrcaRuntimeService,
  worktreeId: string,
  options: { connectionId?: string; allowUnverifiedStop?: boolean } = {}
): Promise<void> {
  const { connectionId, allowUnverifiedStop } = options
  const provider = connectionId ? getSshPtyProvider(connectionId) : getLocalPtyProvider()
  if (!provider) {
    throw new Error(`PTY provider unavailable for worktree deletion: ${worktreeId}`)
  }
  const teardownResult = await killAllProcessesForWorktree(worktreeId, {
    runtime,
    // Why: `repoId::path` ids repeat across hosts, so an unfenced sweep stops a same-id
    // workspace's terminals on another connection — and the selector lookup this replaces
    // throws `selector_ambiguous` the moment two hosts own the id.
    resolvedWorktreeId: worktreeId,
    ...(connectionId ? { resolvedConnectionId: connectionId } : {}),
    localProvider: provider,
    onPtyStopped: clearProviderPtyState,
    requirePhysicalStop: true,
    // Why (#11960): set only by an explicit Force Delete, never by the ordinary
    // confirmation — otherwise the gate would be off on the primary delete path.
    ...(allowUnverifiedStop ? { allowUnverifiedStop: true } : {}),
    ...(connectionId ? { includeLocalRegistry: false } : {})
  })
  const total =
    teardownResult.runtimeStopped + teardownResult.providerStopped + teardownResult.registryStopped
  if (total > 0) {
    console.info(
      `[worktree-teardown] ${worktreeId} killed runtime=${teardownResult.runtimeStopped} provider=${teardownResult.providerStopped} registry=${teardownResult.registryStopped}`
    )
  }
}

function getRepoForWorktreeRemoval(
  store: Store,
  repoId: string,
  hostId?: ExecutionHostId
): Repo | undefined {
  const matches = store
    .getRepos()
    .filter((repo) => repo.id === repoId && (!hostId || getRepoExecutionHostId(repo) === hostId))
  // Why: deletion must never guess between host owners; legacy unscoped calls work only while the repo id has one unique owner.
  if (matches.length === 1) {
    return matches[0]
  }
  if (matches.length > 1) {
    return undefined
  }
  const legacyMatch = store.getRepo(repoId)
  return legacyMatch && (!hostId || getRepoExecutionHostId(legacyMatch) === hostId)
    ? legacyMatch
    : undefined
}
import { classifyWorkspaceCreateError } from './workspace-create-error-classifier'
import { advertisedUrlWatcher } from '../ports/advertised-url-watcher'
import { localhostWorktreeLabelProxy } from '../localhost-worktree-label-proxy'
import {
  assertWorktreeDoesNotContainRegisteredWorktree,
  canCleanupUnregisteredOrcaLeftoverDirectory,
  canCleanupUnregisteredOrcaWorktreeDirectory,
  canSafelyRemoveOrphanedWorktreeDirectory,
  findRegisteredDeletableWorktree,
  isDangerousWorktreeRemovalPath,
  isWorktreePathMissing,
  ORPHANED_WORKTREE_DIRECTORY_MESSAGE,
  stripOrcaProvenanceMetaUpdates,
  UNREGISTERED_MISSING_WORKTREE_MESSAGE
} from '../worktree-removal-safety'
import { DEFAULT_WORKSPACE_STATUS_ID } from '../../shared/workspace-statuses'
import {
  FOLDER_WORKSPACE_INSTANCE_SEPARATOR,
  getRepoIdFromWorktreeId
} from '../../shared/worktree-id'
import { prefetchWorktreeCreateBase } from '../worktree-create-base-prefetch'
import {
  getLocalProjectGitExecOptions,
  getLocalProjectWorktreeGitOptions
} from '../project-runtime-git-options'
import {
  getLocalWorktreePathAccess,
  removeLocalWorktreePath,
  toLocalWorktreeRuntimePath
} from '../local-worktree-filesystem'
import {
  removeStaleLocalWorktreeRegistrationAfterFilesystemRemoval,
  recoverLocalWindowsWorktreeRemoval
} from '../local-worktree-removal-recovery'

const NullableWorkspaceLinkedItemSchema = WorkspaceLinkedItemSchema.nullable()
const NullableTaskSourceContextSchema = TaskSourceContextSchema.nullable()
const WORKTREE_ARCHIVE_HOOK_TIMEOUT_MS = 120_000
const WORKTREE_LIST_ALL_CONCURRENCY = 8

function normalizeLinkedWorkItemFields<
  T extends {
    linkedWorkItem?: unknown
    linkedTaskSourceContext?: unknown
  }
>(input: T): T {
  const linkedWorkItem =
    input.linkedWorkItem === undefined
      ? undefined
      : NullableWorkspaceLinkedItemSchema.parse(input.linkedWorkItem)
  const linkedTaskSourceContext =
    input.linkedTaskSourceContext === undefined
      ? undefined
      : NullableTaskSourceContextSchema.parse(input.linkedTaskSourceContext)
  if (
    linkedWorkItem &&
    linkedTaskSourceContext &&
    !isWorkspaceLinkedItemSourceContextMatch(linkedWorkItem, linkedTaskSourceContext)
  ) {
    throw new Error('Linked work item and source context identities must match')
  }
  return {
    ...input,
    ...(linkedWorkItem !== undefined ? { linkedWorkItem } : {}),
    ...(linkedTaskSourceContext !== undefined ? { linkedTaskSourceContext } : {})
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  let nextIndex = 0
  const workerCount = Math.min(limit, items.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await fn(items[index])
      }
    })
  )
  return results
}

// Why: the worktree's own persisted host outranks the repo fallback; teardown and metadata purge must resolve the same owner
// or the purge lands on the local partition while the SSH/runtime one keeps the workspace's tabs forever.
function resolveWorktreeRemovalOwnerHostId(
  store: Store,
  worktreeId: string,
  repo: Repo | undefined,
  fallbackHostId?: ExecutionHostId
): ExecutionHostId | undefined {
  return (
    store.getWorktreeMeta(worktreeId)?.hostId ??
    (repo ? getRepoExecutionHostId(repo) : fallbackHostId)
  )
}

function removeWorktreeMetadataAndTransientState(
  store: Store,
  worktreeId: string,
  hostId?: ExecutionHostId
): void {
  // Why: worktree IDs are path-derived and reusable; drop process-local caches before the same ID can map to a new workspace.
  if (hostId) {
    store.removeWorktreeMeta(worktreeId, hostId)
  } else {
    store.removeWorktreeMeta(worktreeId)
  }
  advertisedUrlWatcher.forgetWorktree(worktreeId)
  // Why: drop this worktree's localhost label routes so they don't accumulate in the proxy's route maps all session.
  localhostWorktreeLabelProxy.unregisterWorktree(worktreeId)
  // Why: schedule async history tree removal — never recursive-rmSync on the delete critical path.
  deleteWorktreeHistoryDir(worktreeId)
  // Why: release the removed worktree's PR-refresh aliases so coalesced queue entries don't retain it all session (memory creep).
  pruneWorktreePRRefreshAliases(worktreeId)
}

function getProjectHostSetupMetaUpdates(
  store: Store,
  repo: Repo,
  existing?: WorktreeMeta
): Partial<Pick<WorktreeMeta, 'projectId' | 'hostId' | 'projectHostSetupId'>> {
  const ownership = getProjectHostSetupWorktreeMeta(store.getProjectHostSetups(), repo)
  const sameSetup =
    existing?.projectHostSetupId === undefined ||
    existing.projectHostSetupId === ownership.projectHostSetupId
  return {
    // Why: project IDs can upgrade from legacy repo IDs to provider-backed ones; repair ownership on discovery when the host setup matches.
    ...(sameSetup && existing?.projectId !== ownership.projectId
      ? { projectId: ownership.projectId }
      : {}),
    ...(sameSetup && existing?.hostId === undefined ? { hostId: ownership.hostId } : {}),
    ...(existing?.projectHostSetupId === undefined
      ? { projectHostSetupId: ownership.projectHostSetupId }
      : {})
  }
}

// Why: disk-discovered worktrees have no WorktreeMeta, so lastActivityAt=0 sinks them to the bottom of "Recent"; also backfill host-setup ownership here.
function resolveWorktreeMetaWithDiscoveryBackfill(
  store: Store,
  repo: Repo,
  worktreeId: string
): WorktreeMeta {
  const existing = store.getWorktreeMeta(worktreeId)
  const ownershipUpdates = getProjectHostSetupMetaUpdates(store, repo, existing)
  if (existing) {
    const updates = {
      ...(!existing.instanceId ? { instanceId: randomUUID() } : {}),
      ...ownershipUpdates
    }
    if (Object.keys(updates).length > 0) {
      // Why: pre-lineage profiles already have WorktreeMeta rows; backfill on discovery so upgraded workspaces get lineage and host routing.
      return store.setWorktreeMeta(worktreeId, updates)
    }
    return existing
  }
  return store.setWorktreeMeta(worktreeId, {
    lastActivityAt: Date.now(),
    ...ownershipUpdates
  })
}

async function isAlreadyRemovedWorktreePath(
  repo: Repo,
  worktreePath: string,
  localWorktreeGitOptions: { wslDistro?: string } = {}
): Promise<boolean> {
  if (!repo.connectionId) {
    const access = getLocalWorktreePathAccess(localWorktreeGitOptions)
    return isWorktreePathMissing(
      toLocalWorktreeRuntimePath(worktreePath, localWorktreeGitOptions),
      access.statPath
    )
  }

  const fsProvider = getSshFilesystemProvider(repo.connectionId)
  if (!fsProvider) {
    return false
  }
  return isWorktreePathMissing(worktreePath, (path) => fsProvider.stat(path))
}

async function isLocalGitRepository(
  runtimeWorktreePath: string,
  localWorktreeGitOptions: { wslDistro?: string } = {}
): Promise<boolean> {
  try {
    await gitExecFileAsync(['status', '--short'], {
      cwd: runtimeWorktreePath,
      ...localWorktreeGitOptions
    })
    return true
  } catch (error) {
    return !gitStatusErrorMeansNotRepository(error)
  }
}

function gitStatusErrorMeansNotRepository(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === 'object' && 'message' in error
        ? String((error as { message: unknown }).message)
        : typeof error === 'string'
          ? error
          : ''
  const stderr =
    error && typeof error === 'object' && 'stderr' in error
      ? String((error as { stderr: unknown }).stderr)
      : ''
  return /not a git repository/i.test(`${message}\n${stderr}`)
}

function getWorktreeRemovalOptionsKey(args: {
  force?: boolean
  allowUnverifiedPtyStop?: boolean
  skipArchive?: boolean
}): string {
  const forceKey = args.force === true ? 'force' : 'normal'
  const archiveKey = args.skipArchive === true ? 'skip-archive' : 'run-archive'
  // Why: a Force Delete retry must not coalesce onto the in-flight attempt that
  // just failed the PTY gate — it would inherit that failure instead of retrying.
  const ptyKey = args.allowUnverifiedPtyStop === true ? 'allow-unverified-pty' : 'require-pty-stop'
  return `${forceKey}:${archiveKey}:${ptyKey}`
}

function getWorktreeRemovalInFlightKey(worktreeId: string, hostId?: ExecutionHostId): string {
  return `${hostId ?? ''}\0${worktreeId}`
}

async function getArchiveHooksForRemoval(repo: Repo): Promise<OrcaHooks | null> {
  if (!repo.connectionId) {
    return getEffectiveHooks(repo)
  }

  const fsProvider = getSshFilesystemProvider(repo.connectionId)
  if (!fsProvider) {
    return getEffectiveHooksFromConfig(repo, null)
  }

  try {
    const result = await fsProvider.readFile(joinWorktreeRelativePath(repo.path, 'orca.yaml'))
    const yamlHooks = result.isBinary ? null : parseOrcaYaml(result.content)
    return getEffectiveHooksFromConfig(repo, yamlHooks)
  } catch {
    return getEffectiveHooksFromConfig(repo, null)
  }
}

async function runRemoteArchiveHook(
  repo: Repo,
  worktreePath: string,
  script: string
): Promise<{ success: boolean; output: string }> {
  if (!repo.connectionId) {
    return { success: true, output: '' }
  }

  const provider = requireSshGitProvider(repo.connectionId)
  const env = getSetupRunnerEnvVars(repo, worktreePath)
  const isWindowsRemote = isWindowsAbsolutePathLike(worktreePath)
  const result = await provider
    .execNonInteractive(
      isWindowsRemote ? 'cmd.exe' : '/bin/bash',
      isWindowsRemote ? ['/d', '/s', '/c', script] : ['-lc', script],
      worktreePath,
      WORKTREE_ARCHIVE_HOOK_TIMEOUT_MS,
      undefined,
      env
    )
    .catch((error) => ({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      spawnError: error instanceof Error ? error.message : String(error)
    }))
  const output = [
    result.stdout,
    result.stderr,
    result.spawnError,
    result.timedOut ? 'archive hook timed out' : null,
    typeof result.exitCode === 'number' && result.exitCode !== 0
      ? `archive hook exited ${result.exitCode}`
      : null
  ]
    .filter((part): part is string => Boolean(part))
    .join('\n')
    .trim()

  return {
    success: !result.spawnError && !result.timedOut && result.exitCode === 0,
    output
  }
}

type WorktreeRemovalInFlight = {
  optionsKey: string
  promise: Promise<RemoveWorktreeResult>
}

type PreservedBranchCleanupTarget = {
  branchName: string
  head: string
  pushTarget?: GitPushTarget
}

const preservedBranchCleanupByWorktreeId = new Map<string, PreservedBranchCleanupTarget>()

function rememberPreservedBranchCleanupTarget(
  worktreeId: string,
  result: RemoveWorktreeResult | undefined,
  fallbackHead: string | undefined,
  pushTarget: GitPushTarget | undefined
): void {
  if (result?.preservedBranch) {
    const head = result.preservedBranch.head ?? fallbackHead
    if (!head) {
      throw new Error(
        `Cannot safely offer force-delete for preserved branch "${result.preservedBranch.branchName}" without its saved commit.`
      )
    }
    preservedBranchCleanupByWorktreeId.set(worktreeId, {
      branchName: result.preservedBranch.branchName,
      head,
      ...(pushTarget ? { pushTarget } : {})
    })
    return
  }
  preservedBranchCleanupByWorktreeId.delete(worktreeId)
}

function preserveBranchHeadFallback(
  result: RemoveWorktreeResult | undefined,
  fallbackHead: string | undefined
): RemoveWorktreeResult {
  if (!result?.preservedBranch || result.preservedBranch.head || !fallbackHead) {
    return result ?? {}
  }
  return {
    ...result,
    preservedBranch: {
      ...result.preservedBranch,
      head: fallbackHead
    }
  }
}

function getPreservedBranchCleanupTarget(
  worktreeId: string,
  branchName: string,
  expectedHead: string
): PreservedBranchCleanupTarget {
  const target = preservedBranchCleanupByWorktreeId.get(worktreeId)
  if (!target || target.branchName !== branchName || target.head !== expectedHead) {
    throw new Error(`No preserved branch cleanup is pending for "${branchName}".`)
  }
  return target
}

const loggedUnavailableSshGitProviders = new Set<string>()
const loggedWorktreeListFailures = new Set<string>()
const loggedMalformedWorktreeMetaKeys = new Set<string>()
export const DETECTED_WORKTREE_PROVIDER_TIMEOUT_MS = 30_000
export const LINEAGE_HYDRATION_TIMEOUT_MS = 5_000
// Why: absorb renderer polling bursts while bounding external worktree-change lag to one short refresh window.
const DETECTED_WORKTREE_SCAN_CACHE_TTL_MS = 5_000

type DetectedWorktreeScanCacheEntry = {
  expiresAt: number
  worktrees: GitWorktreeInfo[]
}

type DetectedWorktreeScan = {
  invalidated: boolean
  promise: Promise<GitWorktreeInfo[]>
}

type DetectedWorktreeScanResult = {
  gitWorktrees: GitWorktreeInfo[]
  fresh: boolean
}

const detectedWorktreeScanCache = new Map<string, DetectedWorktreeScanCacheEntry>()
const detectedWorktreeScanInFlight = new Map<string, DetectedWorktreeScan>()

function invalidateDetectedWorktreeScanCache(repoId: string): void {
  const keyPrefix = `${repoId}\0`
  for (const key of new Set([
    ...detectedWorktreeScanCache.keys(),
    ...detectedWorktreeScanInFlight.keys()
  ])) {
    if (!key.startsWith(keyPrefix)) {
      continue
    }
    detectedWorktreeScanCache.delete(key)
    const inFlight = detectedWorktreeScanInFlight.get(key)
    if (inFlight) {
      // Why: the detached scan keeps this token so later scans settle without making an older result fresh again.
      inFlight.invalidated = true
      detectedWorktreeScanInFlight.delete(key)
    }
  }
}

registerWorktreeChangeInvalidator(invalidateDetectedWorktreeScanCache)

export function __resetDetectedWorktreeScanCacheForTests(): void {
  // Why: pending scans across a test reset must not repopulate the cache and leak state into the next test.
  for (const scan of detectedWorktreeScanInFlight.values()) {
    scan.invalidated = true
  }
  detectedWorktreeScanCache.clear()
  detectedWorktreeScanInFlight.clear()
}

export function __getDetectedWorktreeScanCacheStatsForTests(): {
  cacheSize: number
  inFlightSize: number
} {
  return {
    cacheSize: detectedWorktreeScanCache.size,
    inFlightSize: detectedWorktreeScanInFlight.size
  }
}

async function listDetectedGitWorktrees(
  store: Store,
  repo: Repo
): Promise<DetectedWorktreeScanResult> {
  const localWorktreeGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  if (repo.connectionId || isFolderRepo(repo)) {
    return {
      gitWorktrees: await listRepoWorktrees(repo, localWorktreeGitOptions),
      fresh: true
    }
  }

  const cacheKey = getDetectedWorktreeScanCacheKey(repo.id, localWorktreeGitOptions)
  const cached = detectedWorktreeScanCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return { gitWorktrees: cached.worktrees, fresh: false }
  }

  const inFlight = detectedWorktreeScanInFlight.get(cacheKey)
  if (inFlight) {
    return { gitWorktrees: await inFlight.promise, fresh: false }
  }

  const scan: DetectedWorktreeScan = {
    invalidated: false,
    promise: listRepoWorktrees(repo, localWorktreeGitOptions)
  }
  detectedWorktreeScanInFlight.set(cacheKey, scan)
  try {
    const gitWorktrees = await scan.promise
    // Why: a create/remove notification can invalidate mid-scan; don't let that stale scan repopulate the cache afterward.
    if (!scan.invalidated) {
      detectedWorktreeScanCache.set(cacheKey, {
        worktrees: gitWorktrees,
        expiresAt: Date.now() + DETECTED_WORKTREE_SCAN_CACHE_TTL_MS
      })
    }
    return { gitWorktrees, fresh: !scan.invalidated }
  } finally {
    if (detectedWorktreeScanInFlight.get(cacheKey) === scan) {
      detectedWorktreeScanInFlight.delete(cacheKey)
    }
  }
}

function getDetectedWorktreeScanCacheKey(
  repoId: string,
  localWorktreeGitOptions: { wslDistro?: string } = {}
): string {
  return `${repoId}\0${localWorktreeGitOptions.wslDistro ?? 'host'}`
}

function warnOnce(keySet: Set<string>, key: string, message: string, error?: unknown): void {
  if (!shouldEmitBoundedWarning(keySet, key)) {
    return
  }
  if (error) {
    console.warn(message, error)
  } else {
    console.warn(message)
  }
}

function rememberLocalWorktreeRoots(
  store: Store,
  repo: Repo,
  gitWorktrees: GitWorktreeInfo[]
): void {
  if (repo.connectionId) {
    return
  }
  // Why: reuse the `git worktree list` result so later git/file IPC validation skips a second scan that can trigger macOS folder-permission prompts.
  registerWorktreeRootsForRepo(store, repo.id, [
    repo.path,
    ...gitWorktrees.map((worktree) => worktree.path)
  ])
}

function pruneLineageForMissingRepoWorktrees(
  store: Store,
  repo: Repo,
  gitWorktrees: GitWorktreeInfo[]
): void {
  if (
    typeof store.getAllWorktreeLineage !== 'function' ||
    typeof store.removeWorktreeLineage !== 'function'
  ) {
    return
  }
  const liveIds = new Set(gitWorktrees.map((worktree) => `${repo.id}::${worktree.path}`))
  const repoPrefix = `${repo.id}::`
  const expectedHostId = getRepoExecutionHostId(repo)
  const repoOwners = store.getRepos().filter((candidate) => candidate.id === repo.id)
  const canMutateWorktree = (worktreeId: string): boolean => {
    const hostId = store.getWorktreeMeta(worktreeId)?.hostId
    return hostId ? hostId === expectedHostId : repoOwners.length === 1
  }
  for (const childWorkspaceKey of Object.keys(store.getAllWorkspaceLineage?.() ?? {})) {
    const childScope = parseWorkspaceKey(childWorkspaceKey)
    if (
      childScope?.type === 'worktree' &&
      childScope.worktreeId.startsWith(repoPrefix) &&
      canMutateWorktree(childScope.worktreeId) &&
      !liveIds.has(childScope.worktreeId)
    ) {
      if (isWorkspaceKey(childWorkspaceKey)) {
        store.removeWorkspaceLineage?.(childWorkspaceKey)
      }
    }
  }
  for (const [childId, lineage] of Object.entries(store.getAllWorktreeLineage())) {
    if (childId.startsWith(repoPrefix) && canMutateWorktree(childId) && !liveIds.has(childId)) {
      // Why: path-derived IDs can be reused; once a scan proves the child is gone, drop its lineage so a future same-path worktree can't inherit it.
      store.removeWorktreeLineage(childId)
      store.removeWorkspaceLineage?.(worktreeWorkspaceKey(childId))
    }
    if (
      lineage.parentWorktreeId.startsWith(repoPrefix) &&
      canMutateWorktree(lineage.parentWorktreeId) &&
      !liveIds.has(lineage.parentWorktreeId)
    ) {
      const parentMeta = store.getWorktreeMeta(lineage.parentWorktreeId)
      if (!parentMeta || parentMeta.instanceId === lineage.parentWorktreeInstanceId) {
        // Why: keep child lineage for the "Missing parent" UI, but rotate the absent parent's identity once so a path reuse can't inherit it.
        store.setWorktreeMeta(lineage.parentWorktreeId, { instanceId: randomUUID() })
      }
    }
  }
}

type SshWorktreeMetaCandidate = {
  id: string
  path: string
  meta: WorktreeMeta
}

type SshWorktreeMetaIndex = Map<string, SshWorktreeMetaCandidate[]>

function createSshWorktreeMetaIndex(entries: [string, WorktreeMeta][]): SshWorktreeMetaIndex {
  const index: SshWorktreeMetaIndex = new Map()
  for (const [worktreeId, meta] of entries) {
    let parsed: { repoId: string; worktreePath: string }
    try {
      parsed = parseWorktreeId(worktreeId)
    } catch (err) {
      warnOnce(
        loggedMalformedWorktreeMetaKeys,
        worktreeId,
        `[worktrees] ignoring malformed persisted worktree metadata key "${worktreeId}"`,
        err
      )
      continue
    }

    const candidates = index.get(parsed.repoId) ?? []
    candidates.push({ id: worktreeId, path: parsed.worktreePath, meta })
    index.set(parsed.repoId, candidates)
  }
  return index
}

function synthesizeSshGitWorktree(repo: Repo, path: string, meta: WorktreeMeta): GitWorktreeInfo {
  return {
    path,
    head: '',
    branch: '',
    isBare: false,
    isMainWorktree: areWorktreePathsEqual(path, repo.path),
    ...(meta.sparseDirectories !== undefined ||
    meta.sparseBaseRef !== undefined ||
    meta.sparsePresetId !== undefined
      ? { isSparse: true }
      : {})
  }
}

function listDisconnectedSshWorktrees(
  store: Store,
  repo: Repo,
  metaIndex: SshWorktreeMetaIndex
): ReturnType<typeof mergeWorktree>[] {
  const byWorktreeId = new Map<string, ReturnType<typeof mergeWorktree>>()
  const expectedHostId = getRepoExecutionHostId(repo)
  const repoOwners = store.getRepos().filter((candidate) => candidate.id === repo.id)
  for (const candidate of metaIndex.get(repo.id) ?? []) {
    if (
      (candidate.meta.hostId && candidate.meta.hostId !== expectedHostId) ||
      (!candidate.meta.hostId && repoOwners.length > 1)
    ) {
      continue
    }
    const ownershipUpdates = getProjectHostSetupMetaUpdates(store, repo, candidate.meta)
    const meta =
      Object.keys(ownershipUpdates).length > 0
        ? { ...candidate.meta, ...ownershipUpdates }
        : candidate.meta
    if (Object.keys(ownershipUpdates).length > 0) {
      store.setWorktreeMeta(candidate.id, ownershipUpdates)
    }
    const worktree = mergeWorktree(
      repo.id,
      synthesizeSshGitWorktree(repo, candidate.path, meta),
      meta
    )
    byWorktreeId.delete(worktree.id)
    byWorktreeId.set(worktree.id, worktree)
  }
  return [...byWorktreeId.values()]
}

function buildDetectedGitWorktrees(
  store: Store,
  repo: Repo,
  gitWorktrees: GitWorktreeInfo[]
): DetectedWorktree[] {
  const settings = store.getSettings()
  const knownOrcaLayouts = buildKnownOrcaWorkspaceLayouts(settings, repo)
  const isLegacyRepoForVisibility = isLegacyRepoForExternalWorktreeVisibility(repo)
  // Why: a prunable registration has no working directory (issue #8389); only this listing omits it — cleanup flows list separately.
  const liveWorktrees = dedupeWorktreesByPath(
    gitWorktrees.filter((gitWorktree) => !gitWorktree.prunable)
  )
  const agentScratchWorktreePathMatcher = createAgentScratchWorktreePathMatcher([
    repo.path,
    ...liveWorktrees.map((worktree) => worktree.path)
  ])
  const detected = liveWorktrees.map((gitWorktree) => {
    const worktreeId = `${repo.id}::${gitWorktree.path}`
    let meta = store.getWorktreeMeta(worktreeId)
    const worktree = mergeWorktree(repo.id, gitWorktree, meta, repo.displayName)
    const detected = toDetectedWorktree({
      repo,
      worktree,
      meta,
      settings,
      knownOrcaLayouts,
      isLegacyRepoForVisibility,
      agentScratchWorktreePathMatcher
    })
    if (!detected.visible) {
      return detected
    }

    meta = resolveWorktreeMetaWithDiscoveryBackfill(store, repo, worktreeId)
    return toDetectedWorktree({
      repo,
      worktree: mergeWorktree(repo.id, gitWorktree, meta, repo.displayName),
      meta,
      settings,
      knownOrcaLayouts,
      isLegacyRepoForVisibility,
      agentScratchWorktreePathMatcher
    })
  })
  return projectResolvedWorktreeLineage(detected, store.getAllWorktreeLineage?.() ?? {})
}

function stampAndMergeVisibleDetectedWorktree(
  store: Store,
  repo: Repo,
  detected: DetectedWorktree
) {
  const meta = resolveWorktreeMetaWithDiscoveryBackfill(store, repo, detected.id)
  return mergeWorktree(repo.id, detected, meta, repo.displayName)
}

function getFolderWorkspaceRootId(repo: Repo): string {
  return `${repo.id}::${repo.path}`
}

function getFolderWorkspaceInstanceId(repo: Repo, instanceId: string): string {
  return `${getFolderWorkspaceRootId(repo)}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}${instanceId}`
}

function getFolderWorkspaceInstanceIdentity(repo: Repo, worktreeId: string): string {
  const prefix = `${getFolderWorkspaceRootId(repo)}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}`
  return worktreeId.startsWith(prefix) ? worktreeId.slice(prefix.length) : randomUUID()
}

function isFolderWorkspaceIdForRepo(repo: Repo, worktreeId: string): boolean {
  const rootId = getFolderWorkspaceRootId(repo)
  return (
    worktreeId === rootId ||
    worktreeId.startsWith(`${rootId}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}`)
  )
}

function mergeFolderWorkspace(repo: Repo, worktreeId: string, meta: WorktreeMeta): Worktree {
  return {
    id: worktreeId,
    ...(meta.instanceId !== undefined ? { instanceId: meta.instanceId } : {}),
    repoId: repo.id,
    ...(meta.projectId !== undefined ? { projectId: meta.projectId } : {}),
    ...(meta.hostId !== undefined ? { hostId: meta.hostId } : {}),
    ...(meta.projectHostSetupId !== undefined
      ? { projectHostSetupId: meta.projectHostSetupId }
      : {}),
    path: repo.path,
    head: '',
    branch: '',
    isBare: false,
    isMainWorktree: worktreeId === getFolderWorkspaceRootId(repo),
    displayName: meta.displayName || repo.displayName,
    comment: meta.comment || '',
    linkedIssue: meta.linkedIssue ?? null,
    linkedPR: meta.linkedPR ?? null,
    linkedLinearIssue: meta.linkedLinearIssue ?? null,
    linkedLinearIssueWorkspaceId: meta.linkedLinearIssueWorkspaceId ?? null,
    linkedLinearIssueOrganizationUrlKey: meta.linkedLinearIssueOrganizationUrlKey ?? null,
    linkedGitLabMR: meta.linkedGitLabMR ?? null,
    linkedGitLabIssue: meta.linkedGitLabIssue ?? null,
    linkedBitbucketPR: meta.linkedBitbucketPR ?? null,
    linkedAzureDevOpsPR: meta.linkedAzureDevOpsPR ?? null,
    linkedGiteaPR: meta.linkedGiteaPR ?? null,
    linkedWorkItem: meta.linkedWorkItem ?? null,
    linkedTaskSourceContext: meta.linkedTaskSourceContext ?? null,
    isArchived: meta.isArchived ?? false,
    isUnread: meta.isUnread ?? false,
    isPinned: meta.isPinned ?? false,
    sortOrder: meta.sortOrder ?? 0,
    ...(meta.manualOrder !== undefined ? { manualOrder: meta.manualOrder } : {}),
    lastActivityAt: meta.lastActivityAt ?? 0,
    ...(meta.createdAt !== undefined ? { createdAt: meta.createdAt } : {}),
    ...(meta.createdWithAgent !== undefined ? { createdWithAgent: meta.createdWithAgent } : {}),
    ...(meta.automationProvenance !== undefined
      ? { automationProvenance: meta.automationProvenance }
      : {}),
    ...(meta.cliProvenance !== undefined ? { cliProvenance: meta.cliProvenance } : {}),
    ...(meta.priorWorktreeIds !== undefined ? { priorWorktreeIds: meta.priorWorktreeIds } : {}),
    workspaceStatus: meta.workspaceStatus ?? DEFAULT_WORKSPACE_STATUS_ID,
    diffComments: meta.diffComments,
    mobileDiffReview: meta.mobileDiffReview
  }
}

function listFolderWorkspaces(store: Store, repo: Repo): Worktree[] {
  const rootId = getFolderWorkspaceRootId(repo)
  const allMeta = store.getAllWorktreeMeta()
  const ids = Object.keys(allMeta).filter((worktreeId) =>
    isFolderWorkspaceIdForRepo(repo, worktreeId)
  )
  if (!ids.includes(rootId)) {
    ids.unshift(rootId)
  }

  return ids
    .map((worktreeId) => {
      const existing = allMeta[worktreeId]
      const ownershipUpdates = getProjectHostSetupMetaUpdates(store, repo, existing)
      const meta =
        existing?.instanceId && Object.keys(ownershipUpdates).length === 0
          ? existing
          : store.setWorktreeMeta(worktreeId, {
              instanceId:
                existing?.instanceId ?? getFolderWorkspaceInstanceIdentity(repo, worktreeId),
              ...ownershipUpdates,
              ...(existing ? {} : { displayName: repo.displayName, lastActivityAt: Date.now() })
            })
      return mergeFolderWorkspace(repo, worktreeId, meta)
    })
    .sort((a, b) => {
      if (a.id === rootId) {
        return -1
      }
      if (b.id === rootId) {
        return 1
      }
      return (b.createdAt ?? b.lastActivityAt) - (a.createdAt ?? a.lastActivityAt)
    })
}

function buildFolderDetectedWorktrees(store: Store, repo: Repo): DetectedWorktree[] {
  const settings = store.getSettings()
  return listFolderWorkspaces(store, repo).map((worktree) =>
    toDetectedWorktree({
      repo,
      worktree,
      meta: store.getWorktreeMeta(worktree.id),
      settings,
      knownOrcaLayouts: [],
      isLegacyRepoForVisibility: true
    })
  )
}

function listVisibleFolderWorkspaces(store: Store, repo: Repo): Worktree[] {
  return buildFolderDetectedWorktrees(store, repo)
    .filter((worktree) => worktree.visible)
    .map((worktree) => {
      const meta = store.getWorktreeMeta(worktree.id)
      const ownershipUpdates = getProjectHostSetupMetaUpdates(store, repo, meta)
      const repairedMeta =
        meta && Object.keys(ownershipUpdates).length === 0
          ? meta
          : store.setWorktreeMeta(worktree.id, ownershipUpdates)
      return mergeFolderWorkspace(repo, worktree.id, repairedMeta)
    })
}

function createFolderWorkspace(
  args: CreateWorktreeArgsWithSystemProvenance,
  repo: Repo,
  store: Store
): CreateWorktreeResult {
  const now = Date.now()
  const instanceId = randomUUID()
  const worktreeId = getFolderWorkspaceInstanceId(repo, instanceId)
  const meta = store.setWorktreeMeta(worktreeId, {
    instanceId,
    ...(store.getProjectHostSetups
      ? getProjectHostSetupWorktreeMeta(store.getProjectHostSetups(), repo)
      : {}),
    displayName: args.displayName || args.name,
    lastActivityAt: now,
    createdAt: now,
    orcaCreatedAt: now,
    orcaCreationSource: 'desktop',
    ...(args.automationProvenance ? { automationProvenance: args.automationProvenance } : {}),
    ...(args.cliProvenance ? { cliProvenance: args.cliProvenance } : {}),
    ...(args.createdWithAgent ? { createdWithAgent: args.createdWithAgent } : {}),
    ...(args.linkedIssue !== undefined ? { linkedIssue: args.linkedIssue } : {}),
    ...(args.linkedPR !== undefined ? { linkedPR: args.linkedPR } : {}),
    ...(args.linkedLinearIssue !== undefined ? { linkedLinearIssue: args.linkedLinearIssue } : {}),
    ...(args.linkedLinearIssueWorkspaceId !== undefined
      ? { linkedLinearIssueWorkspaceId: args.linkedLinearIssueWorkspaceId }
      : {}),
    ...(args.linkedLinearIssueOrganizationUrlKey !== undefined
      ? { linkedLinearIssueOrganizationUrlKey: args.linkedLinearIssueOrganizationUrlKey }
      : {}),
    ...(args.manualOrder !== undefined ? { manualOrder: args.manualOrder } : {}),
    ...(args.workspaceStatus !== undefined ? { workspaceStatus: args.workspaceStatus } : {}),
    ...(args.linkedGitLabIssue !== undefined ? { linkedGitLabIssue: args.linkedGitLabIssue } : {}),
    ...(args.linkedGitLabMR !== undefined ? { linkedGitLabMR: args.linkedGitLabMR } : {}),
    ...(args.linkedBitbucketPR !== undefined ? { linkedBitbucketPR: args.linkedBitbucketPR } : {}),
    ...(args.linkedAzureDevOpsPR !== undefined
      ? { linkedAzureDevOpsPR: args.linkedAzureDevOpsPR }
      : {}),
    ...(args.linkedGiteaPR !== undefined ? { linkedGiteaPR: args.linkedGiteaPR } : {}),
    ...(args.linkedWorkItem !== undefined ? { linkedWorkItem: args.linkedWorkItem } : {}),
    ...(args.linkedTaskSourceContext !== undefined
      ? { linkedTaskSourceContext: args.linkedTaskSourceContext }
      : {})
  })
  return { worktree: mergeFolderWorkspace(repo, worktreeId, meta) }
}

function buildDisconnectedDetectedWorktrees(
  store: Store,
  repo: Repo,
  worktrees: Worktree[]
): DetectedWorktree[] {
  const settings = store.getSettings()
  const agentScratchWorktreePathMatcher = createAgentScratchWorktreePathMatcher([
    repo.path,
    ...worktrees.map((worktree) => worktree.path)
  ])
  const detected = worktrees.map((worktree) => {
    const meta = store.getWorktreeMeta(worktree.id)
    const detected = toDetectedWorktree({
      repo,
      worktree,
      meta,
      settings,
      knownOrcaLayouts: [],
      isLegacyRepoForVisibility: true,
      agentScratchWorktreePathMatcher
    })
    return applyMetadataFallbackVisibility(detected)
  })
  return projectResolvedWorktreeLineage(detected, store.getAllWorktreeLineage?.() ?? {})
}

function hasConflictingStoredWorktreeOwner(
  store: Store,
  repo: Repo,
  worktreeIds: readonly string[]
): boolean {
  const expectedHostId = getRepoExecutionHostId(repo)
  const repoOwnerCount = store.getRepos().filter((candidate) => candidate.id === repo.id).length
  return worktreeIds.some((worktreeId) => {
    const meta = store.getWorktreeMeta(worktreeId)
    return !!meta && (meta.hostId ? meta.hostId !== expectedHostId : repoOwnerCount > 1)
  })
}

type RepoOwnershipEvidence =
  | { status: 'owned'; hostId: ExecutionHostId }
  | { status: 'malformed' }
  | { status: 'contradictory' }

function resolveRepoOwnershipEvidence(repo: Repo): RepoOwnershipEvidence {
  const hasExplicitHost = repo.executionHostId !== null && repo.executionHostId !== undefined
  const explicitHost = hasExplicitHost ? parseExecutionHostId(repo.executionHostId) : null
  if (hasExplicitHost && !explicitHost) {
    return { status: 'malformed' }
  }
  const hasConnection = repo.connectionId !== null && repo.connectionId !== undefined
  const connectionId = hasConnection ? repo.connectionId?.trim() : null
  if (hasConnection && !connectionId) {
    return { status: 'malformed' }
  }
  const connectionHostId = connectionId ? toSshExecutionHostId(connectionId) : null
  if (explicitHost && connectionHostId && explicitHost.id !== connectionHostId) {
    return { status: 'contradictory' }
  }
  return {
    status: 'owned',
    hostId: explicitHost?.id ?? connectionHostId ?? LOCAL_EXECUTION_HOST_ID
  }
}

function findExactRepoOwner(
  store: Store,
  repoId: string,
  executionHostId?: ExecutionHostId
): Repo | undefined {
  const candidates = store.getRepos().filter((repo) => repo.id === repoId)
  const evidence = candidates.map(resolveRepoOwnershipEvidence)
  if (evidence.some((owner) => owner.status !== 'owned')) {
    return undefined
  }
  const matches = candidates.filter((_, index) => {
    const owner = evidence[index]
    return (
      owner?.status === 'owned' &&
      (executionHostId === undefined || owner.hostId === executionHostId)
    )
  })
  return matches.length === 1 ? matches[0] : undefined
}

function isCapturedRepoCurrent(
  store: Store,
  repo: Repo,
  executionHostId?: ExecutionHostId
): boolean {
  const current = findExactRepoOwner(store, repo.id, executionHostId)
  return (
    current !== undefined &&
    current.path === repo.path &&
    (current.connectionId ?? null) === (repo.connectionId ?? null) &&
    (current.executionHostId ?? null) === (repo.executionHostId ?? null)
  )
}

async function listDetectedWorktreesForCapturedRepo(
  store: Store,
  repo: Repo,
  isCurrent: () => boolean,
  capturedProvider = repo.connectionId ? getSshGitProvider(repo.connectionId) : undefined,
  providerAbort?: { signal: AbortSignal; status: () => 'canceled' | 'timed-out' }
): Promise<DetectedWorktreeListResult | { providerAbortStatus: 'canceled' | 'timed-out' } | null> {
  const abortedResult = () =>
    providerAbort?.signal.aborted
      ? ({ providerAbortStatus: providerAbort.status() } as const)
      : undefined
  const sshWorktreeMetaIndex = repo.connectionId
    ? createSshWorktreeMetaIndex(Object.entries(store.getAllWorktreeMeta()))
    : new Map()

  try {
    let gitWorktrees: GitWorktreeInfo[]
    let freshScan = true
    if (isFolderRepo(repo)) {
      if (!isCurrent()) {
        return null
      }
      const folderWorkspaceIds = Object.keys(store.getAllWorktreeMeta()).filter((worktreeId) =>
        isFolderWorkspaceIdForRepo(repo, worktreeId)
      )
      if (hasConflictingStoredWorktreeOwner(store, repo, folderWorkspaceIds)) {
        return {
          repoId: repo.id,
          authoritative: false,
          source: 'metadata-fallback',
          worktrees: []
        }
      }
      return {
        repoId: repo.id,
        authoritative: true,
        source: 'git',
        worktrees: projectResolvedWorktreeLineage(
          buildFolderDetectedWorktrees(store, repo),
          store.getAllWorktreeLineage?.() ?? {}
        )
      }
    }
    if (repo.connectionId) {
      if (!capturedProvider) {
        const aborted = abortedResult()
        if (aborted) {
          return aborted
        }
        if (!isCurrent()) {
          return null
        }
        const worktrees = listDisconnectedSshWorktrees(store, repo, sshWorktreeMetaIndex)
        return {
          repoId: repo.id,
          authoritative: false,
          source: 'metadata-fallback',
          worktrees: buildDisconnectedDetectedWorktrees(store, repo, worktrees)
        }
      }
      gitWorktrees = await capturedProvider.listWorktrees(repo.path, {
        signal: providerAbort?.signal
      })
    } else {
      const scan = await listDetectedGitWorktrees(store, repo)
      gitWorktrees = scan.gitWorktrees
      freshScan = scan.fresh
    }
    const aborted = abortedResult()
    if (aborted) {
      return aborted
    }
    if (!isCurrent()) {
      return null
    }
    const listedWorktreeIds = gitWorktrees.map((worktree) => `${repo.id}::${worktree.path}`)
    if (hasConflictingStoredWorktreeOwner(store, repo, listedWorktreeIds)) {
      return {
        repoId: repo.id,
        authoritative: false,
        source: 'metadata-fallback',
        worktrees: []
      }
    }
    if (freshScan) {
      rememberLocalWorktreeRoots(store, repo, gitWorktrees)
      pruneLineageForMissingRepoWorktrees(store, repo, gitWorktrees)
    }
    loggedWorktreeListFailures.delete(`${repo.id}:${repo.path}`)
    return {
      repoId: repo.id,
      authoritative: true,
      source: 'git',
      worktrees: buildDetectedGitWorktrees(store, repo, gitWorktrees)
    }
  } catch (err) {
    const aborted = abortedResult()
    if (aborted) {
      return aborted
    }
    if (!isCurrent()) {
      return null
    }
    warnOnce(
      loggedWorktreeListFailures,
      `${repo.id}:${repo.path}`,
      `[worktrees] failed to list detected worktrees for repo "${repo.displayName}" (${repo.id}) at ${repo.path}`,
      err
    )
    if (repo.connectionId) {
      const worktrees = listDisconnectedSshWorktrees(store, repo, sshWorktreeMetaIndex)
      return {
        repoId: repo.id,
        authoritative: false,
        source: 'metadata-fallback',
        worktrees: buildDisconnectedDetectedWorktrees(store, repo, worktrees)
      }
    }
    return { repoId: repo.id, authoritative: false, source: 'metadata-fallback', worktrees: [] }
  }
}

function hasValidDirectSshAuthority(
  args: DirectSshDetectedWorktreeRequest
): args is DirectSshDetectedWorktreeRequest {
  return isAdmissibleDirectSshAuthority(args.expectedAuthority)
}

function hasValidLineageSshAuthority(
  args: ListDesktopLineageForHostArgs
): args is Extract<ListDesktopLineageForHostArgs, { expectedAuthority: unknown }> {
  if (!('expectedAuthority' in args)) {
    return false
  }
  return isAdmissibleDirectSshAuthority(args.expectedAuthority)
}

type LineageOwner =
  | { status: 'owned'; hostId: ExecutionHostId }
  | { status: 'ambiguous' | 'contradictory' | 'runtime' }

type LineageFolder = ReturnType<Store['getFolderWorkspaces']>[number]
type LineageGroup = ReturnType<Store['getProjectGroups']>[number]

type LineageResolutionContext = {
  store: Store
  repos: Repo[]
  groups: LineageGroup[]
  reposById: Map<string, Repo[]>
  foldersById: Map<string, LineageFolder[]>
  groupsById: Map<string, LineageGroup[]>
  groupSubtreeIdsByRoot: Map<string, Set<string>>
  worktreeOwners: Map<string, LineageOwner>
  folderOwners: Map<string, LineageOwner>
  workspaceOwners: Map<string, LineageOwner>
}

function indexLineageEntriesById<T extends { id: string }>(
  entries: readonly T[]
): Map<string, T[]> {
  const index = new Map<string, T[]>()
  for (const entry of entries) {
    const matching = index.get(entry.id) ?? []
    matching.push(entry)
    index.set(entry.id, matching)
  }
  return index
}

function createLineageResolutionContext(store: Store): LineageResolutionContext {
  const repos = store.getRepos()
  const folders = store.getFolderWorkspaces()
  const groups = store.getProjectGroups()
  return {
    store,
    repos,
    groups,
    reposById: indexLineageEntriesById(repos),
    foldersById: indexLineageEntriesById(folders),
    groupsById: indexLineageEntriesById(groups),
    groupSubtreeIdsByRoot: new Map(),
    worktreeOwners: new Map(),
    folderOwners: new Map(),
    workspaceOwners: new Map()
  }
}

function resolveRepoLineageOwner(repo: Repo): LineageOwner {
  const owner = resolveRepoOwnershipEvidence(repo)
  if (owner.status === 'malformed') {
    return { status: 'ambiguous' }
  }
  if (owner.status === 'contradictory') {
    return { status: 'contradictory' }
  }
  return parseExecutionHostId(owner.hostId)?.kind === 'runtime' ? { status: 'runtime' } : owner
}

function resolveWorktreeLineageOwner(
  context: LineageResolutionContext,
  worktreeId: string
): LineageOwner {
  const cached = context.worktreeOwners.get(worktreeId)
  if (cached) {
    return cached
  }
  const remember = (owner: LineageOwner): LineageOwner => {
    context.worktreeOwners.set(worktreeId, owner)
    return owner
  }
  let repoId: string
  try {
    repoId = parseWorktreeId(worktreeId).repoId
  } catch {
    return remember({ status: 'ambiguous' })
  }
  const repos = context.reposById.get(repoId) ?? []
  const meta = context.store.getWorktreeMeta(worktreeId)
  const runtimeOwnerEnvironmentId = (
    meta as (WorktreeMeta & { runtimeOwnerEnvironmentId?: string }) | undefined
  )?.runtimeOwnerEnvironmentId?.trim()
  if (runtimeOwnerEnvironmentId) {
    return remember({ status: 'runtime' })
  }
  if (meta?.hostId) {
    const explicitHost = parseExecutionHostId(meta.hostId)
    if (!explicitHost) {
      return remember({ status: 'ambiguous' })
    }
    if (explicitHost.kind === 'runtime') {
      return remember({ status: 'runtime' })
    }
    const matchingRepos = repos.filter((repo) => {
      const owner = resolveRepoLineageOwner(repo)
      return owner.status === 'owned' && owner.hostId === explicitHost.id
    })
    if (matchingRepos.length === 1) {
      return remember({ status: 'owned', hostId: explicitHost.id })
    }
    return remember(
      matchingRepos.length > 1
        ? { status: 'ambiguous' }
        : { status: repos.length > 0 ? 'contradictory' : 'ambiguous' }
    )
  }
  if (repos.length !== 1) {
    return remember({ status: 'ambiguous' })
  }
  return remember(resolveRepoLineageOwner(repos[0]))
}

function getFolderLineageCandidateRepos(
  context: LineageResolutionContext,
  folder: LineageFolder
): Repo[] {
  let groupIds = context.groupSubtreeIdsByRoot.get(folder.projectGroupId)
  if (!groupIds) {
    groupIds = getProjectGroupSubtreeIds(context.groups, folder.projectGroupId)
    context.groupSubtreeIdsByRoot.set(folder.projectGroupId, groupIds)
  }
  const grouped = context.repos.filter(
    (repo) => typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)
  )
  const pathRepos = context.repos.filter(
    (repo) =>
      !(typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)) &&
      isPathInsideOrEqual(folder.folderPath, repo.path)
  )
  const group = context.groupsById.get(folder.projectGroupId)?.[0]
  const connectionId = folder.connectionId ?? group?.connectionId ?? null
  return connectionId
    ? [...grouped, ...pathRepos.filter((repo) => (repo.connectionId ?? null) === connectionId)]
    : grouped.length > 0
      ? [
          ...grouped,
          ...pathRepos.filter((repo) =>
            new Set(grouped.map((candidate) => candidate.connectionId ?? null)).has(
              repo.connectionId ?? null
            )
          )
        ]
      : pathRepos
}

function resolveFolderLineageOwner(
  context: LineageResolutionContext,
  folderWorkspaceId: string
): LineageOwner {
  const cached = context.folderOwners.get(folderWorkspaceId)
  if (cached) {
    return cached
  }
  const remember = (owner: LineageOwner): LineageOwner => {
    context.folderOwners.set(folderWorkspaceId, owner)
    return owner
  }
  const folders = context.foldersById.get(folderWorkspaceId) ?? []
  if (folders.length !== 1) {
    return remember({ status: 'ambiguous' })
  }
  const folder = folders[0]
  const groups = context.groupsById.get(folder.projectGroupId) ?? []
  if (groups.length !== 1) {
    return remember({ status: 'ambiguous' })
  }
  const group = groups[0]
  const hosts = new Set<ExecutionHostId>()
  if (folder.connectionId) {
    hosts.add(`ssh:${encodeURIComponent(folder.connectionId)}`)
  }
  if (group.connectionId) {
    hosts.add(`ssh:${encodeURIComponent(group.connectionId)}`)
  }
  if (group.executionHostId) {
    const parsed = parseExecutionHostId(group.executionHostId)
    if (!parsed) {
      return remember({ status: 'ambiguous' })
    }
    hosts.add(parsed.id)
  }
  for (const repo of getFolderLineageCandidateRepos(context, folder)) {
    const owner = resolveRepoLineageOwner(repo)
    if (owner.status !== 'owned') {
      return remember(owner)
    }
    hosts.add(owner.hostId)
  }
  if (hosts.size > 1) {
    return remember({ status: 'contradictory' })
  }
  const hostId = [...hosts][0] ?? LOCAL_EXECUTION_HOST_ID
  return remember(
    parseExecutionHostId(hostId)?.kind === 'runtime'
      ? { status: 'runtime' }
      : { status: 'owned', hostId }
  )
}

function resolveWorkspaceLineageOwner(
  context: LineageResolutionContext,
  workspaceKey: string
): LineageOwner {
  const cached = context.workspaceOwners.get(workspaceKey)
  if (cached) {
    return cached
  }
  const workspace = parseWorkspaceKey(workspaceKey)
  const owner = !workspace
    ? { status: 'ambiguous' as const }
    : workspace.type === 'worktree'
      ? resolveWorktreeLineageOwner(context, workspace.worktreeId)
      : resolveFolderLineageOwner(context, workspace.folderWorkspaceId)
  context.workspaceOwners.set(workspaceKey, owner)
  return owner
}

function filterLineageForHost(
  store: Store,
  executionHostId: ExecutionHostId
): {
  worktreeLineageById: Record<string, WorktreeLineage>
  workspaceLineageByChildKey: Record<string, WorkspaceLineage>
} | null {
  const context = createLineageResolutionContext(store)
  const worktreeLineageById: Record<string, WorktreeLineage> = {}
  const workspaceLineageByChildKey: Record<string, WorkspaceLineage> = {}
  for (const [worktreeId, lineage] of Object.entries(store.getAllWorktreeLineage())) {
    const child = resolveWorktreeLineageOwner(context, worktreeId)
    const parent = resolveWorktreeLineageOwner(context, lineage.parentWorktreeId)
    if (child.status === 'ambiguous' || child.status === 'contradictory') {
      return null
    }
    if (parent.status === 'ambiguous' || parent.status === 'contradictory') {
      return null
    }
    if (
      child.status === 'owned' &&
      parent.status === 'owned' &&
      child.hostId === executionHostId &&
      parent.hostId === executionHostId
    ) {
      worktreeLineageById[worktreeId] = structuredClone(lineage)
    } else if (
      child.status === 'owned' &&
      parent.status === 'owned' &&
      child.hostId !== parent.hostId
    ) {
      return null
    }
  }
  for (const [childKey, lineage] of Object.entries(store.getAllWorkspaceLineage())) {
    const child = resolveWorkspaceLineageOwner(context, childKey)
    const parent = resolveWorkspaceLineageOwner(context, lineage.parentWorkspaceKey)
    if (child.status === 'ambiguous' || child.status === 'contradictory') {
      return null
    }
    if (parent.status === 'ambiguous' || parent.status === 'contradictory') {
      return null
    }
    if (
      child.status === 'owned' &&
      parent.status === 'owned' &&
      child.hostId === executionHostId &&
      parent.hostId === executionHostId
    ) {
      workspaceLineageByChildKey[childKey] = structuredClone(lineage)
    } else if (
      child.status === 'owned' &&
      parent.status === 'owned' &&
      child.hostId !== parent.hostId
    ) {
      return null
    }
  }
  return { worktreeLineageById, workspaceLineageByChildKey }
}

async function hydrateLineageWithinDeadline(runtime: OrcaRuntimeService): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const hydration = Promise.resolve()
    .then(() => runtime.hydrateInferredWorktreeLineage())
    .then(
      () => true,
      () => false
    )
  const deadline = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), LINEAGE_HYDRATION_TIMEOUT_MS)
  })
  try {
    return await Promise.race([hydration, deadline])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

async function listDesktopLineageForHost(
  store: Store,
  runtime: OrcaRuntimeService,
  args: ListDesktopLineageForHostArgs
): Promise<HostLineageSnapshot> {
  const parsedHost = parseExecutionHostId(args?.executionHostId)
  const rejected = (
    reason: Extract<HostLineageSnapshot, { authoritative: false }>['reason']
  ): HostLineageSnapshot => ({
    authoritative: false,
    executionHostId: args.executionHostId,
    reason
  })
  if (!parsedHost || parsedHost.kind === 'runtime') {
    return rejected('rejected')
  }
  let provider: ReturnType<typeof getSshGitProvider> | undefined
  let authority:
    | Extract<ListDesktopLineageForHostArgs, { expectedAuthority: unknown }>['expectedAuthority']
    | null = null
  if (parsedHost.kind === 'local') {
    if ('expectedAuthority' in args) {
      return rejected('rejected')
    }
  } else {
    if (
      !hasValidLineageSshAuthority(args) ||
      args.expectedAuthority.targetId !== parsedHost.targetId
    ) {
      return rejected('rejected')
    }
    authority = { ...args.expectedAuthority }
    if (!isCurrentSshProviderAuthority(authority)) {
      return rejected('stale')
    }
    provider = getSshGitProvider(parsedHost.targetId)
    if (!provider) {
      return rejected('unavailable')
    }
  }
  if (!(await hydrateLineageWithinDeadline(runtime))) {
    return rejected('unavailable')
  }
  if (
    parsedHost.kind === 'ssh' &&
    (!authority ||
      getSshGitProvider(parsedHost.targetId) !== provider ||
      !isCurrentSshProviderAuthority(authority))
  ) {
    return rejected('stale')
  }
  const lineage = filterLineageForHost(store, parsedHost.id)
  if (!lineage) {
    return rejected('ambiguous-owner')
  }
  if (parsedHost.kind === 'local') {
    return {
      authoritative: true,
      authority: { kind: 'local', executionHostId: LOCAL_EXECUTION_HOST_ID },
      ...lineage
    }
  }
  if (!authority) {
    return rejected('authority-unknown')
  }
  return {
    authoritative: true,
    authority: {
      kind: 'direct-ssh',
      executionHostId: parsedHost.id,
      ...authority
    },
    ...lineage
  }
}

async function listHostQualifiedDetectedWorktrees(
  store: Store,
  args: ListDetectedWorktreesArgs,
  providerAbort?: { signal: AbortSignal; status: () => 'canceled' | 'timed-out' }
): Promise<HostQualifiedDetectedWorktreeResult> {
  const parsedHost = parseExecutionHostId(args.executionHostId)
  const rejected = (status: 'rejected' | 'stale' | 'ambiguous-owner') => ({
    providerRequestId: args.providerRequestId,
    executionHostId: args.executionHostId,
    status
  })
  if (
    typeof args.providerRequestId !== 'string' ||
    args.providerRequestId.length === 0 ||
    Buffer.byteLength(args.providerRequestId, 'utf8') > PROVIDER_REQUEST_ID_MAX_UTF8_BYTES ||
    !parsedHost ||
    parsedHost.kind === 'runtime'
  ) {
    return rejected('rejected')
  }
  let capturedAuthority: DirectSshDetectedWorktreeRequest['expectedAuthority'] | null = null
  if (parsedHost.kind === 'ssh') {
    const directArgs = args as DirectSshDetectedWorktreeRequest
    if (
      !hasValidDirectSshAuthority(directArgs) ||
      directArgs.expectedAuthority.targetId !== parsedHost.targetId
    ) {
      return rejected('rejected')
    }
    capturedAuthority = { ...directArgs.expectedAuthority }
    if (!isCurrentSshProviderAuthority(capturedAuthority)) {
      return rejected('stale')
    }
  }

  const repoCandidates = store.getRepos().filter((candidate) => candidate.id === args.repoId)
  if (
    repoCandidates.some((candidate) => resolveRepoOwnershipEvidence(candidate).status !== 'owned')
  ) {
    return rejected('rejected')
  }
  const repo = findExactRepoOwner(store, args.repoId, args.executionHostId)
  if (!repo) {
    return rejected('ambiguous-owner')
  }
  if (
    (parsedHost.kind === 'local' && repo.connectionId) ||
    (parsedHost.kind === 'ssh' && repo.connectionId !== parsedHost.targetId)
  ) {
    return rejected('rejected')
  }
  const provider = parsedHost.kind === 'ssh' ? getSshGitProvider(parsedHost.targetId) : undefined
  const isCurrent = (): boolean => {
    if (!isCapturedRepoCurrent(store, repo, args.executionHostId)) {
      return false
    }
    if (
      (parsedHost.kind === 'local' && repo.connectionId) ||
      (parsedHost.kind === 'ssh' && repo.connectionId !== parsedHost.targetId)
    ) {
      return false
    }
    if (parsedHost.kind !== 'ssh') {
      return true
    }
    return (
      capturedAuthority !== null &&
      getSshGitProvider(parsedHost.targetId) === provider &&
      isCurrentSshProviderAuthority(capturedAuthority)
    )
  }
  const result = await listDetectedWorktreesForCapturedRepo(
    store,
    repo,
    isCurrent,
    provider,
    providerAbort
  )
  if (!result) {
    return rejected('stale')
  }
  if ('providerAbortStatus' in result) {
    return {
      providerRequestId: args.providerRequestId,
      executionHostId: args.executionHostId,
      status: result.providerAbortStatus
    }
  }
  const status = result.authoritative ? 'complete' : 'non-authoritative'
  if (parsedHost.kind === 'local') {
    return {
      status,
      providerRequestId: args.providerRequestId,
      repoId: repo.id,
      authority: { kind: 'local', executionHostId: LOCAL_EXECUTION_HOST_ID },
      result
    }
  }
  if (!capturedAuthority) {
    return rejected('rejected')
  }
  return {
    status,
    providerRequestId: args.providerRequestId,
    repoId: repo.id,
    authority: {
      kind: 'direct-ssh',
      executionHostId: args.executionHostId as `ssh:${string}`,
      ...capturedAuthority
    },
    result
  }
}

export function registerWorktreeHandlers(
  mainWindow: BrowserWindow,
  store: Store,
  runtime: OrcaRuntimeService,
  options?: { onWorktreeLifecycle?: (event: RuntimeWorktreeLifecycleEvent) => void }
): void {
  const detectedWorktreeCancellations = createSenderScopedRequestCancellations()
  // Remove previously registered handlers so re-register works when macOS re-activates and creates a new window.
  ipcMain.removeHandler('worktrees:listAll')
  ipcMain.removeHandler('worktrees:list')
  ipcMain.removeHandler('worktrees:listDetected')
  ipcMain.removeHandler('worktrees:cancelListDetected')
  ipcMain.removeHandler('worktrees:create')
  ipcMain.removeHandler('worktrees:prefetchCreateBase')
  ipcMain.removeHandler('worktrees:resolvePrBase')
  ipcMain.removeHandler('worktrees:resolveMrBase')
  ipcMain.removeHandler('worktrees:remove')
  ipcMain.removeHandler('worktrees:forgetLocal')
  ipcMain.removeHandler('worktrees:forceDeletePreservedBranch')
  ipcMain.removeHandler('worktrees:updateMeta')
  ipcMain.removeHandler('worktrees:listLineage')
  ipcMain.removeHandler('worktrees:listLineageForHost')
  ipcMain.removeHandler('worktrees:updateLineage')
  ipcMain.removeHandler('worktrees:persistSortOrder')
  ipcMain.removeHandler('worktrees:getBranchRenameFailureOutput')
  ipcMain.removeHandler('hooks:check')
  ipcMain.removeHandler('hooks:inspectSetupScriptImports')
  ipcMain.removeHandler('hooks:createIssueCommandRunner')
  ipcMain.removeHandler('hooks:readIssueCommand')
  ipcMain.removeHandler('hooks:writeIssueCommand')

  ipcMain.handle('worktrees:listAll', async () => {
    const repos = store.getRepos()
    const sshWorktreeMetaIndex = repos.some((repo) => repo.connectionId)
      ? createSshWorktreeMetaIndex(Object.entries(store.getAllWorktreeMeta()))
      : new Map()

    // Why: each local repo listing can spawn `git worktree list`; cap fan-out so large fleets don't start unbounded subprocesses.
    const results = await mapWithConcurrency(repos, WORKTREE_LIST_ALL_CONCURRENCY, async (repo) => {
      try {
        let gitWorktrees
        let freshScan = true
        if (isFolderRepo(repo)) {
          return listVisibleFolderWorkspaces(store, repo)
        } else if (repo.connectionId) {
          const provider = getSshGitProvider(repo.connectionId)
          if (!provider) {
            warnOnce(
              loggedUnavailableSshGitProviders,
              `${repo.connectionId}:${repo.id}`,
              `[worktrees] SSH git provider unavailable; skipping worktree list for repo "${repo.displayName}" (${repo.id}) at ${repo.path} on connection ${repo.connectionId}`
            )
            return listDisconnectedSshWorktrees(store, repo, sshWorktreeMetaIndex)
          }
          loggedUnavailableSshGitProviders.delete(`${repo.connectionId}:${repo.id}`)
          try {
            gitWorktrees = await provider.listWorktrees(repo.path)
          } catch (err) {
            warnOnce(
              loggedWorktreeListFailures,
              `${repo.id}:${repo.path}`,
              `[worktrees] failed to list worktrees for repo "${repo.displayName}" (${repo.id}) at ${repo.path}`,
              err
            )
            return listDisconnectedSshWorktrees(store, repo, sshWorktreeMetaIndex)
          }
        } else {
          const scan = await listDetectedGitWorktrees(store, repo)
          gitWorktrees = scan.gitWorktrees
          freshScan = scan.fresh
        }
        if (freshScan) {
          rememberLocalWorktreeRoots(store, repo, gitWorktrees)
          pruneLineageForMissingRepoWorktrees(store, repo, gitWorktrees)
        }
        loggedWorktreeListFailures.delete(`${repo.id}:${repo.path}`)
        return buildDetectedGitWorktrees(store, repo, gitWorktrees)
          .filter((worktree) => worktree.visible)
          .map((worktree) => stampAndMergeVisibleDetectedWorktree(store, repo, worktree))
      } catch (err) {
        warnOnce(
          loggedWorktreeListFailures,
          `${repo.id}:${repo.path}`,
          `[worktrees] failed to list worktrees for repo "${repo.displayName}" (${repo.id}) at ${repo.path}`,
          err
        )
        // Why: do NOT seed empty success — it flags the repo registered, blocking access to legit linked worktrees until the cache is invalidated.
        return []
      }
    })

    return results.flat()
  })

  ipcMain.handle('worktrees:list', async (_event, args: { repoId: string }) => {
    const repo = store.getRepo(args.repoId)
    if (!repo) {
      return []
    }
    const sshWorktreeMetaIndex = repo.connectionId
      ? createSshWorktreeMetaIndex(Object.entries(store.getAllWorktreeMeta()))
      : new Map()

    try {
      let gitWorktrees
      let freshScan = true
      if (isFolderRepo(repo)) {
        return listVisibleFolderWorkspaces(store, repo)
      } else if (repo.connectionId) {
        const provider = getSshGitProvider(repo.connectionId)
        if (!provider) {
          warnOnce(
            loggedUnavailableSshGitProviders,
            `${repo.connectionId}:${repo.id}`,
            `[worktrees] SSH git provider unavailable; skipping worktree list for repo "${repo.displayName}" (${repo.id}) at ${repo.path} on connection ${repo.connectionId}`
          )
          return listDisconnectedSshWorktrees(store, repo, sshWorktreeMetaIndex)
        }
        loggedUnavailableSshGitProviders.delete(`${repo.connectionId}:${repo.id}`)
        try {
          gitWorktrees = await provider.listWorktrees(repo.path)
        } catch (err) {
          warnOnce(
            loggedWorktreeListFailures,
            `${repo.id}:${repo.path}`,
            `[worktrees] failed to list worktrees for repo "${repo.displayName}" (${repo.id}) at ${repo.path}`,
            err
          )
          return listDisconnectedSshWorktrees(store, repo, sshWorktreeMetaIndex)
        }
      } else {
        const scan = await listDetectedGitWorktrees(store, repo)
        gitWorktrees = scan.gitWorktrees
        freshScan = scan.fresh
      }
      if (freshScan) {
        rememberLocalWorktreeRoots(store, repo, gitWorktrees)
        pruneLineageForMissingRepoWorktrees(store, repo, gitWorktrees)
      }
      loggedWorktreeListFailures.delete(`${repo.id}:${repo.path}`)
      return buildDetectedGitWorktrees(store, repo, gitWorktrees)
        .filter((worktree) => worktree.visible)
        .map((worktree) => stampAndMergeVisibleDetectedWorktree(store, repo, worktree))
    } catch (err) {
      warnOnce(
        loggedWorktreeListFailures,
        `${repo.id}:${repo.path}`,
        `[worktrees] failed to list worktrees for repo "${repo.displayName}" (${repo.id}) at ${repo.path}`,
        err
      )
      // Why: see worktrees:listAll catch — seeding an empty-success result would poison the auth cache and block linked worktrees.
      return []
    }
  })

  ipcMain.handle(
    'worktrees:listDetected',
    async (
      event,
      args: DetectedWorktreeRequestArgs
    ): Promise<DetectedWorktreeListResult | HostQualifiedDetectedWorktreeResult> => {
      if ('executionHostId' in args) {
        const parsedHost = parseExecutionHostId(args.executionHostId)
        const directSshRequest = parsedHost?.kind === 'ssh'
        const controller = directSshRequest
          ? detectedWorktreeCancellations.begin(event, args.providerRequestId)
          : null
        const directArgs = args as DirectSshDetectedWorktreeRequest
        const removeAuthorityAbort =
          controller &&
          parsedHost?.kind === 'ssh' &&
          hasValidDirectSshAuthority(directArgs) &&
          directArgs.expectedAuthority.targetId === parsedHost.targetId
            ? registerSshProviderRequestAbort(directArgs.expectedAuthority, controller)
            : undefined
        let timedOut = false
        let removeAbortListener: (() => void) | undefined
        const abortedResult = controller
          ? new Promise<HostQualifiedDetectedWorktreeResult>((resolve) => {
              const onAbort = (): void => {
                resolve({
                  providerRequestId: args.providerRequestId,
                  executionHostId: args.executionHostId,
                  status: timedOut ? 'timed-out' : 'canceled'
                })
              }
              controller.signal.addEventListener('abort', onAbort, { once: true })
              removeAbortListener = () => controller.signal.removeEventListener('abort', onAbort)
            })
          : undefined
        const timeout = controller
          ? setTimeout(() => {
              timedOut = true
              controller.abort()
            }, DETECTED_WORKTREE_PROVIDER_TIMEOUT_MS)
          : undefined
        try {
          const providerResult = listHostQualifiedDetectedWorktrees(
            store,
            args,
            controller
              ? {
                  signal: controller.signal,
                  status: () => (timedOut ? 'timed-out' : 'canceled')
                }
              : undefined
          )
          return abortedResult
            ? await Promise.race([providerResult, abortedResult])
            : await providerResult
        } finally {
          if (timeout) {
            clearTimeout(timeout)
          }
          removeAbortListener?.()
          removeAuthorityAbort?.()
          detectedWorktreeCancellations.finish(event, args.providerRequestId, controller)
        }
      }
      const repo = findExactRepoOwner(store, args.repoId)
      if (!repo) {
        return {
          repoId: args.repoId,
          authoritative: false,
          source: 'metadata-fallback',
          worktrees: []
        }
      }
      const provider = repo.connectionId ? getSshGitProvider(repo.connectionId) : undefined
      const authority = repo.connectionId
        ? { ...getSshProviderAuthority(repo.connectionId) }
        : undefined
      const result = await listDetectedWorktreesForCapturedRepo(
        store,
        repo,
        () =>
          isCapturedRepoCurrent(store, repo) &&
          (!repo.connectionId ||
            (getSshGitProvider(repo.connectionId) === provider &&
              authority !== undefined &&
              isCurrentSshProviderAuthority(authority))),
        provider
      )
      return result && !('providerAbortStatus' in result)
        ? result
        : {
            repoId: repo.id,
            authoritative: false,
            source: 'metadata-fallback',
            worktrees: []
          }
    }
  )
  ipcMain.handle(
    'worktrees:cancelListDetected',
    (event, args: { providerRequestId: ProviderRequestId }): void => {
      detectedWorktreeCancellations.cancel(event, args.providerRequestId)
    }
  )

  ipcMain.handle(
    'worktrees:prefetchCreateBase',
    async (_event, args: { repoId: string; baseBranch?: string }): Promise<void> => {
      const repo = store.getRepo(args.repoId)
      if (!repo) {
        return
      }
      try {
        await prefetchWorktreeCreateBase({ repo, baseBranch: args.baseBranch, runtime })
      } catch {
        // Why: optimistic warm-up; the real create path awaits the same refresh and reports failures there.
      }
    }
  )

  ipcMain.handle(
    'worktrees:create',
    async (_event, rawArgs: CreateWorktreeArgs): Promise<CreateWorktreeResult> => {
      const args = normalizeLinkedWorkItemFields(rawArgs)
      // Why span here: parent the child git spans for the trace tree; don't attach branch name/remote URL (user content) — repo ID is the safer correlator.
      return withWorktreeSpan({ stage: 'create' }, async () => {
        const repo = store.getRepo(args.repoId)
        if (!repo) {
          throw new Error(`Repo not found: ${args.repoId}`)
        }

        const sourceParse = workspaceSourceSchema.safeParse(args.telemetrySource)
        const source: WorkspaceSource = sourceParse.success ? sourceParse.data : 'unknown'

        const automationProvenance = resolveAutomationWorkspaceProvenance({
          authority: runtime,
          repoSelector: args.repoId,
          repo,
          request: args.automationProvenanceRequest
        })
        const createArgs: CreateWorktreeArgsWithSystemProvenance = {
          ...args,
          automationProvenance
        }

        let result: CreateWorktreeResult
        try {
          // Why: wrap only the helpers; the pre-validation throws above are IPC-shape bugs, not the git/filesystem failures the funnel tracks.
          result = isFolderRepo(repo)
            ? createFolderWorkspace(createArgs, repo, store)
            : repo.connectionId
              ? await createRemoteWorktree(createArgs, repo, store, mainWindow)
              : await createLocalWorktree(createArgs, repo, store, mainWindow, runtime)
        } catch (error) {
          releaseAutomationWorkspaceProvenanceRequest(args.automationProvenanceRequest)
          track('workspace_create_failed', {
            source,
            error_class: classifyWorkspaceCreateError(error),
            ...getCohortAtEmit()
          })
          throw error
        }
        finishAutomationWorkspaceProvenanceRequest(args.automationProvenanceRequest)

        // Why: reaching here means create succeeded (helpers throw); skip a separate workspace_initialized (telemetry-plan.md§Deferred); never send the branch name.
        track('workspace_created', {
          source,
          from_existing_branch:
            !isFolderRepo(repo) &&
            typeof args.baseBranch === 'string' &&
            args.baseBranch.length > 0,
          ...getCohortAtEmit()
        })

        if (isFolderRepo(repo)) {
          notifyWorktreesChanged(mainWindow, repo.id)
        }

        options?.onWorktreeLifecycle?.({
          kind: 'created',
          worktreeId: result.worktree.id,
          path: result.worktree.path,
          branch: result.worktree.branch
        })

        return result
      })
    }
  )

  ipcMain.handle(
    'worktrees:resolvePrBase',
    async (
      _event,
      args: {
        repoId: string
        prNumber: number
        headRefName?: string
        baseRefName?: string
        isCrossRepository?: boolean
      }
    ): Promise<GitHubPrStartPoint | { error: string }> => {
      const repo = store.getRepo(args.repoId)
      if (!repo) {
        return { error: 'Repo not found' }
      }
      if (isFolderRepo(repo)) {
        return { error: 'Folder mode does not support creating worktrees.' }
      }
      const gitExec = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
        if (!repo.connectionId) {
          return gitExecFileAsync(args, getLocalProjectGitExecOptions(store, repo))
        }
        const provider = getSshGitProvider(repo.connectionId)
        if (!provider) {
          throw new Error(
            'SSH Git provider is not available. Reconnect to this target and try again.'
          )
        }
        return provider.exec(args, repo.path)
      }
      // Why: SSH review-head fetches require narrow write-capable RPCs.
      const fetchRemoteTrackingRef = (remote: string, branch: string): Promise<void> =>
        fetchPrHeadTrackingRef(
          repo,
          repo.connectionId ? getSshGitProvider(repo.connectionId) : undefined,
          remote,
          branch,
          { localGitExecOptions: getLocalProjectGitExecOptions(store, repo) }
        )
      const fetchPullRequestHeadRef = (remote: string, prNumber: number): Promise<string> =>
        fetchGitHubPullRequestHeadRef(
          repo,
          repo.connectionId ? getSshGitProvider(repo.connectionId) : undefined,
          remote,
          prNumber,
          { localGitExecOptions: getLocalProjectGitExecOptions(store, repo) }
        )

      return resolveGitHubPrStartPoint({
        repoPath: repo.path,
        prNumber: args.prNumber,
        headRefName: args.headRefName,
        baseRefName: args.baseRefName,
        isCrossRepository: args.isCrossRepository,
        issueSourcePreference: repo.issueSourcePreference,
        connectionId: repo.connectionId ?? null,
        localGitOptions: getLocalProjectWorktreeGitOptions(store, repo),
        gitExec,
        fetchRemoteTrackingRef,
        fetchPullRequestHeadRef,
        // Why: one resolver keeps source preference and hosting identity aligned
        // across local, WSL, and SSH worktree creation.
        resolveRemote: () =>
          resolveGitHubReviewHeadRemote({
            repoPath: repo.path,
            issueSourcePreference: repo.issueSourcePreference,
            connectionId: repo.connectionId ?? null,
            localGitOptions: getLocalProjectWorktreeGitOptions(store, repo),
            gitExec
          })
      })
    }
  )

  // Why: keep desktop IPC and mobile/runtime RPC on the same MR-base path so SSH repos don't regress differently per surface.
  ipcMain.handle(
    'worktrees:resolveMrBase',
    async (
      _event,
      args: {
        repoId: string
        mrIid: number
        sourceBranch?: string
        targetBranch?: string
        isCrossRepository?: boolean
      }
    ): Promise<
      | { baseBranch: string; compareBaseRef?: string; pushTarget?: GitPushTarget }
      | { error: string }
    > => {
      return runtime.resolveManagedMrBase({
        repoSelector: `id:${args.repoId}`,
        mrIid: args.mrIid,
        sourceBranch: args.sourceBranch,
        targetBranch: args.targetBranch,
        isCrossRepository: args.isCrossRepository
      })
    }
  )

  const worktreeRemovalsInFlight = new Map<string, WorktreeRemovalInFlight>()

  ipcMain.handle(
    'worktrees:remove',
    async (_event, args: RemoveWorktreeArgs): Promise<RemoveWorktreeResult> => {
      const { repoId, worktreePath } = parseWorktreeId(args.worktreeId)
      const repo = getRepoForWorktreeRemoval(store, repoId, args.hostId)
      if (!repo) {
        throw new Error(`Repo not found: ${repoId}`)
      }
      // The resolved repo supplies host ownership when legacy callers omit args.hostId.
      const removalHostId = getRepoExecutionHostId(repo)
      const inFlightKey = getWorktreeRemovalInFlightKey(args.worktreeId, removalHostId)
      const optionsKey = getWorktreeRemovalOptionsKey(args)
      const inFlightRemoval = worktreeRemovalsInFlight.get(inFlightKey)
      if (inFlightRemoval) {
        if (inFlightRemoval.optionsKey === optionsKey) {
          return inFlightRemoval.promise
        }
        throw new Error(`Worktree deletion already in progress: ${args.worktreeId}`)
      }

      // Why: concurrent stale-toast/double-click/sidebar races can hit the same worktree; share the op so only one path touches Git and disk.
      const removal = (async (): Promise<RemoveWorktreeResult> => {
        // Why: worktree.create is traced; delete freezes were invisible without a matching worktree.remove parent span.
        return withWorktreeSpan({ stage: 'remove', path: worktreePath }, async () => {
          if (isFolderRepo(repo)) {
            if (args.worktreeId === getFolderWorkspaceRootId(repo)) {
              throw new Error(
                'Cannot delete the project root workspace. Remove the folder project instead.'
              )
            }
            // Why: folder workspaces share one root, so there's no Git remove step to close shells; sweep PTYs before dropping metadata.
            await withWorktreeRemoveStageSpan('pty_sweep', 'folder', async () => {
              // Folder projects can be SSH-backed, so fence the sweep to the owning host exactly
              // like the git paths — the local inventory must never reach a remote workspace's id.
              const ownerHost = parseExecutionHostId(
                resolveWorktreeRemovalOwnerHostId(store, args.worktreeId, repo, args.hostId)
              )
              const sshPtyProvider =
                ownerHost?.kind === 'ssh' ? getSshPtyProvider(ownerHost.targetId) : undefined
              const externalHost = ownerHost?.kind === 'ssh' || ownerHost?.kind === 'runtime'
              await killAllProcessesForWorktree(args.worktreeId, {
                runtime,
                resolvedWorktreeId: args.worktreeId,
                ...(ownerHost?.kind === 'ssh' ? { resolvedConnectionId: ownerHost.targetId } : {}),
                ...(ownerHost?.kind === 'runtime'
                  ? { resolvedRuntimeEnvironmentId: ownerHost.environmentId }
                  : {}),
                localProvider: sshPtyProvider ?? getLocalPtyProvider(),
                onPtyStopped: clearProviderPtyState,
                ...(externalHost
                  ? {
                      includeProviderInventory:
                        ownerHost?.kind === 'ssh' && Boolean(sshPtyProvider),
                      includeLocalRegistry: false
                    }
                  : {})
              }).catch((err) => {
                console.warn(`[worktree-teardown] failed for ${args.worktreeId}:`, err)
              })
            })
            await withWorktreeRemoveStageSpan('metadata_purge', 'folder', async () => {
              removeWorktreeMetadataAndTransientState(store, args.worktreeId, removalHostId)
            })
            preservedBranchCleanupByWorktreeId.delete(args.worktreeId)
            notifyWorktreesChanged(mainWindow, repoId)
            return {}
          }

          // Why: renderer-supplied worktreeId embeds a path; re-derive the canonical path from git before any destructive action.
          const provider = repo.connectionId ? requireSshGitProvider(repo.connectionId) : null
          const localWorktreeGitOptions = repo.connectionId
            ? {}
            : getLocalProjectWorktreeGitOptions(store, repo)
          const hasLocalWorktreeGitOptions = Object.keys(localWorktreeGitOptions).length > 0
          const registeredWorktrees = repo.connectionId
            ? await provider!.listWorktrees(repo.path)
            : hasLocalWorktreeGitOptions
              ? await listGitWorktreesStrict(repo.path, localWorktreeGitOptions)
              : await listGitWorktreesStrict(repo.path)
          const removedMeta = store.getWorktreeMeta(args.worktreeId)
          const removedPushTarget = removedMeta?.pushTarget
          const registeredWorktree = findRegisteredDeletableWorktree(
            repo.path,
            worktreePath,
            registeredWorktrees
          )
          if (!registeredWorktree) {
            const fsProvider = repo.connectionId
              ? getSshFilesystemProvider(repo.connectionId)
              : null
            let canCleanOrphanedDirectory = false
            if (
              canCleanupUnregisteredOrcaWorktreeDirectory({
                meta: removedMeta
              })
            ) {
              if (repo.connectionId) {
                if (!fsProvider) {
                  throw new Error('SSH filesystem provider unavailable')
                }
                if (!fsProvider.lstat) {
                  throw new Error('SSH filesystem provider lstat unavailable')
                }
                canCleanOrphanedDirectory = await canSafelyRemoveOrphanedWorktreeDirectory(
                  worktreePath,
                  repo.path,
                  (path) => fsProvider.lstat!(path),
                  (path) => fsProvider.readFile(path)
                )
              } else {
                const access = getLocalWorktreePathAccess(localWorktreeGitOptions)
                canCleanOrphanedDirectory =
                  !isDangerousWorktreeRemovalPath(worktreePath, repo.path) &&
                  (await canSafelyRemoveOrphanedWorktreeDirectory(
                    toLocalWorktreeRuntimePath(worktreePath, localWorktreeGitOptions),
                    toLocalWorktreeRuntimePath(repo.path, localWorktreeGitOptions),
                    access.statPath,
                    access.readPath
                  ))
              }
            }
            if (canCleanOrphanedDirectory) {
              assertWorktreeDoesNotContainRegisteredWorktree(worktreePath, registeredWorktrees)
              if (!args.force) {
                throw new Error(ORPHANED_WORKTREE_DIRECTORY_MESSAGE)
              }
              if (repo.connectionId) {
                const removalGate = await runtime.acquireFileWatcherRemoval(
                  worktreePath,
                  repo.connectionId
                )
                let removalCompleted = false
                try {
                  await stopPtysForDestructiveWorktreeRemoval(runtime, args.worktreeId, {
                    connectionId: repo.connectionId,
                    allowUnverifiedStop: args.allowUnverifiedPtyStop
                  })
                  await fsProvider!.deletePath(worktreePath, true)
                  removalCompleted = true
                } finally {
                  await removalGate.finish(removalCompleted)
                }
                await cleanupUnusedWorktreePushTargetRemoteSsh(
                  provider!,
                  repo.path,
                  args.worktreeId,
                  removedPushTarget,
                  store
                )
              } else {
                const removalGate = await runtime.acquireFileWatcherRemoval(worktreePath)
                let removalCompleted = false
                try {
                  await stopPtysForDestructiveWorktreeRemoval(runtime, args.worktreeId, {
                    allowUnverifiedStop: args.allowUnverifiedPtyStop
                  })
                  await removeLocalWorktreePath(worktreePath, localWorktreeGitOptions)
                  removalCompleted = true
                } finally {
                  await removalGate.finish(removalCompleted)
                }
                await cleanupUnusedWorktreePushTargetRemote(
                  repo.path,
                  args.worktreeId,
                  removedPushTarget,
                  store,
                  localWorktreeGitOptions
                )
                invalidateAuthorizedRootsCache()
              }
              runtime.clearOptimisticReconcileToken(args.worktreeId)
              removeWorktreeMetadataAndTransientState(store, args.worktreeId, removalHostId)
              preservedBranchCleanupByWorktreeId.delete(args.worktreeId)
              notifyWorktreesChanged(mainWindow, repoId)
              return {}
            }
            if (!repo.connectionId) {
              const access = getLocalWorktreePathAccess(localWorktreeGitOptions)
              const runtimeWorktreePath = toLocalWorktreeRuntimePath(
                worktreePath,
                localWorktreeGitOptions
              )
              if (
                await canCleanupUnregisteredOrcaLeftoverDirectory({
                  meta: removedMeta,
                  worktreePath,
                  runtimeWorktreePath,
                  repo,
                  runtimeRepoPath: toLocalWorktreeRuntimePath(repo.path, localWorktreeGitOptions),
                  registeredWorktrees,
                  statPath: access.statPath,
                  isGitRepository: (path) => isLocalGitRepository(path, localWorktreeGitOptions)
                })
              ) {
                if (!args.force) {
                  throw new Error(ORPHANED_WORKTREE_DIRECTORY_MESSAGE)
                }
                const removalGate = await runtime.acquireFileWatcherRemoval(worktreePath)
                let removalCompleted = false
                try {
                  await stopPtysForDestructiveWorktreeRemoval(runtime, args.worktreeId, {
                    allowUnverifiedStop: args.allowUnverifiedPtyStop
                  })
                  await removeLocalWorktreePath(worktreePath, localWorktreeGitOptions)
                  removalCompleted = true
                } finally {
                  await removalGate.finish(removalCompleted)
                }
                await cleanupUnusedWorktreePushTargetRemote(
                  repo.path,
                  args.worktreeId,
                  removedPushTarget,
                  store,
                  localWorktreeGitOptions
                )
                runtime.clearOptimisticReconcileToken(args.worktreeId)
                removeWorktreeMetadataAndTransientState(store, args.worktreeId, removalHostId)
                preservedBranchCleanupByWorktreeId.delete(args.worktreeId)
                invalidateAuthorizedRootsCache()
                notifyWorktreesChanged(mainWindow, repoId)
                return {}
              }
            }
            if (await isAlreadyRemovedWorktreePath(repo, worktreePath, localWorktreeGitOptions)) {
              if (!args.force && !removedMeta) {
                // Why: without persisted metadata, require the renderer recovery path before deleting Orca-only state for an unregistered path.
                throw new Error(UNREGISTERED_MISSING_WORKTREE_MESSAGE)
              }
              // Why: a manually deleted worktree is already gone; persisted metadata proves it was an Orca-known row, so no force is needed.
              if (repo.connectionId) {
                await cleanupUnusedWorktreePushTargetRemoteSsh(
                  provider!,
                  repo.path,
                  args.worktreeId,
                  removedPushTarget,
                  store
                )
              } else {
                await cleanupUnusedWorktreePushTargetRemote(
                  repo.path,
                  args.worktreeId,
                  removedPushTarget,
                  store,
                  localWorktreeGitOptions
                )
                invalidateAuthorizedRootsCache()
              }
              runtime.clearOptimisticReconcileToken(args.worktreeId)
              removeWorktreeMetadataAndTransientState(store, args.worktreeId, removalHostId)
              preservedBranchCleanupByWorktreeId.delete(args.worktreeId)
              notifyWorktreesChanged(mainWindow, repoId)
              return {}
            }
            throw new Error(`Refusing to delete unregistered worktree path: ${worktreePath}`)
          }
          const canonicalWorktreePath = registeredWorktree.path
          const deleteBranch = removedMeta?.preserveBranchOnDelete !== true

          // Why: a Git lock must block before archive hooks or linked-path cleanup mutate the workspace; dirty-file force is separate.
          try {
            assertWorktreeUnlockedForRemoval(registeredWorktree)
          } catch (error) {
            throw new Error(
              formatWorktreeRemovalError(error, canonicalWorktreePath, args.force ?? false)
            )
          }

          // Why: a prior forced Windows recovery can delete the dir but leave a stale Git registration; verify before clearing metadata.
          if (
            !repo.connectionId &&
            args.force === true &&
            process.platform === 'win32' &&
            (isWindowsAbsolutePathLike(canonicalWorktreePath) ||
              !!localWorktreeGitOptions.wslDistro) &&
            removedMeta &&
            (await isAlreadyRemovedWorktreePath(
              repo,
              canonicalWorktreePath,
              localWorktreeGitOptions
            ))
          ) {
            const removalResult = await removeStaleLocalWorktreeRegistrationAfterFilesystemRemoval({
              canonicalWorktreePath,
              repoPath: repo.path,
              localWorktreeGitOptions,
              registeredWorktree,
              deleteBranch
            })
            await cleanupUnusedWorktreePushTargetRemote(
              repo.path,
              args.worktreeId,
              removedPushTarget,
              store,
              localWorktreeGitOptions
            )
            rememberPreservedBranchCleanupTarget(
              args.worktreeId,
              removalResult,
              registeredWorktree.head,
              removedPushTarget
            )
            runtime.clearOptimisticReconcileToken(args.worktreeId)
            removeWorktreeMetadataAndTransientState(store, args.worktreeId, removalHostId)
            invalidateAuthorizedRootsCache()
            notifyWorktreesChanged(mainWindow, repoId)
            return removalResult ?? {}
          }

          // Run archive hook before removal so teardown scripts still see the worktree directory.
          const hooks = await getArchiveHooksForRemoval(repo)
          const archiveScript = hooks?.scripts.archive
          if (archiveScript && !args.skipArchive) {
            // Why the branch on connectionId: this block is shared by both flows, so a hardcoded
            // 'remote' would file every local archive hook under the SSH breakdown.
            await withWorktreeRemoveStageSpan(
              'archive_hook',
              repo.connectionId ? 'remote' : 'local',
              async () => {
                const result = repo.connectionId
                  ? await runRemoteArchiveHook(repo, canonicalWorktreePath, archiveScript)
                  : await runHook(
                      'archive',
                      canonicalWorktreePath,
                      repo,
                      undefined,
                      localWorktreeGitOptions
                    )
                if (!result.success) {
                  console.error(
                    `[hooks] archive hook failed for ${canonicalWorktreePath}:`,
                    result.output
                  )
                }
              }
            )
          }

          const remoteConnectionId = repo.connectionId ?? undefined
          if (remoteConnectionId) {
            // Why: SSH deletion mirrors the local flow — hooks run while the directory is intact, then the clean check guards removal.
            if (!args.force) {
              const { clean, stdout } = await provider!.worktreeIsClean(canonicalWorktreePath)
              if (!clean) {
                const error = new Error('Worktree has uncommitted or untracked changes.')
                ;(error as Error & { stdout?: string }).stdout = stdout
                throw error
              }
            }

            const remoteRemoveOptions = !deleteBranch ? { deleteBranch } : {}
            const removalGate = await withWorktreeRemoveStageSpan(
              'watcher_gate',
              'remote',
              async () =>
                runtime.acquireFileWatcherRemoval(canonicalWorktreePath, remoteConnectionId)
            )
            let rawRemovalResult: RemoveWorktreeResult | undefined
            let removalCompleted = false
            try {
              await withWorktreeRemoveStageSpan('pty_sweep', 'remote', async () => {
                await stopPtysForDestructiveWorktreeRemoval(runtime, args.worktreeId, {
                  connectionId: remoteConnectionId,
                  allowUnverifiedStop: args.allowUnverifiedPtyStop
                })
              })
              rawRemovalResult = await withWorktreeRemoveStageSpan(
                'git_remove',
                'remote',
                async () =>
                  Object.keys(remoteRemoveOptions).length > 0
                    ? provider!.removeWorktree(
                        canonicalWorktreePath,
                        args.force,
                        remoteRemoveOptions
                      )
                    : provider!.removeWorktree(canonicalWorktreePath, args.force)
              )
              removalCompleted = true
            } finally {
              await removalGate.finish(removalCompleted)
            }
            const removalResult = preserveBranchHeadFallback(
              rawRemovalResult,
              registeredWorktree.head
            )
            await cleanupUnusedWorktreePushTargetRemoteSsh(
              provider!,
              repo.path,
              args.worktreeId,
              removedPushTarget,
              store
            )
            rememberPreservedBranchCleanupTarget(
              args.worktreeId,
              removalResult,
              registeredWorktree.head,
              removedPushTarget
            )
            runtime.clearOptimisticReconcileToken(args.worktreeId)
            await withWorktreeRemoveStageSpan('metadata_purge', 'remote', async () => {
              removeWorktreeMetadataAndTransientState(store, args.worktreeId, removalHostId)
            })
            notifyWorktreesChanged(mainWindow, repoId)
            return removalResult ?? {}
          }

          const refreshedWorktrees = hasLocalWorktreeGitOptions
            ? await listGitWorktreesStrict(repo.path, localWorktreeGitOptions)
            : await listGitWorktreesStrict(repo.path)
          const refreshedRegisteredWorktree = findRegisteredDeletableWorktree(
            repo.path,
            canonicalWorktreePath,
            refreshedWorktrees
          )
          if (!refreshedRegisteredWorktree) {
            throw new Error(
              `Worktree registration changed during deletion: ${canonicalWorktreePath}. Retry deletion.`
            )
          }
          try {
            // Why: an archive hook can race another Git client that locks the row; recheck before linked-path/watcher/terminal teardown.
            assertWorktreeUnlockedForRemoval(refreshedRegisteredWorktree)
          } catch (error) {
            throw new Error(
              formatWorktreeRemovalError(error, canonicalWorktreePath, args.force ?? false)
            )
          }

          // Why: `orca.yaml` shared directories are symlinked in too, and a
          // directory-only ignore rule leaves those links untracked, so removal must
          // tolerate and unlink them exactly like the per-user shared paths.
          const linkedPaths = getWorktreeSharedLinkPaths(repo)
          const ignoredLinkedPaths = args.force
            ? []
            : await findExistingWorktreeSymlinkPaths(canonicalWorktreePath, linkedPaths)
          try {
            await (hasLocalWorktreeGitOptions
              ? assertWorktreeCleanForRemoval(canonicalWorktreePath, args.force ?? false, {
                  ...localWorktreeGitOptions,
                  ...(ignoredLinkedPaths.length > 0
                    ? { ignoredUntrackedPaths: ignoredLinkedPaths }
                    : {})
                })
              : ignoredLinkedPaths.length > 0
                ? assertWorktreeCleanForRemoval(canonicalWorktreePath, args.force ?? false, {
                    ignoredUntrackedPaths: ignoredLinkedPaths
                  })
                : assertWorktreeCleanForRemoval(canonicalWorktreePath, args.force ?? false))
          } catch (error) {
            if (!isOrphanCompatiblePreflightError(error)) {
              throw new Error(
                formatWorktreeRemovalError(error, canonicalWorktreePath, args.force ?? false)
              )
            }
            // Why: Git can still classify this as an orphan after preflight; keep strict PTY teardown before any recursive fallback deletion.
          }

          let removalResult: RemoveWorktreeResult | undefined
          const removalGate = await withWorktreeRemoveStageSpan('watcher_gate', 'local', async () =>
            runtime.acquireFileWatcherRemoval(canonicalWorktreePath)
          )
          let removalCompleted = false
          try {
            // Why: hold the watcher/terminal gate through Git and any recursive fallback so no late spawn recreates a native handle.
            // Linked-path deletion is destructive too, so PTYs must release every handle before Windows or WSL filesystem cleanup starts.
            await withWorktreeRemoveStageSpan('pty_sweep', 'local', async () => {
              await stopPtysForDestructiveWorktreeRemoval(runtime, args.worktreeId, {
                allowUnverifiedStop: args.allowUnverifiedPtyStop
              })
            })

            // Why: preflight only ignored these paths, not mutated them; keep watcher installs fenced through Git removal.
            if (linkedPaths.length > 0) {
              await removeWorktreeLinkedPaths(canonicalWorktreePath, linkedPaths)
            }

            try {
              const removeOptions = {
                ...(!deleteBranch ? { deleteBranch } : {}),
                // Why: reuse the authoritative worktree list already computed here instead of rescanning siblings on the hot delete path.
                knownRemovedWorktree: refreshedRegisteredWorktree,
                ...(hasLocalWorktreeGitOptions ? localWorktreeGitOptions : {})
              }
              removalResult = preserveBranchHeadFallback(
                await withWorktreeRemoveStageSpan('git_remove', 'local', async () =>
                  removeWorktree(
                    repo.path,
                    canonicalWorktreePath,
                    args.force ?? false,
                    removeOptions
                  )
                ),
                refreshedRegisteredWorktree.head
              )
            } catch (error) {
              // Why: Git for Windows can deregister a clean worktree before its recursive filesystem deletion fails transiently.
              const recoveredRemovalResult = await recoverLocalWindowsWorktreeRemoval({
                error,
                force: args.force ?? false,
                canonicalWorktreePath,
                repoPath: repo.path,
                localWorktreeGitOptions,
                registeredWorktree: refreshedRegisteredWorktree,
                deleteBranch,
                closeWatcher: (worktreePath) => runtime.closeFileWatchersForRemoval(worktreePath)
              })
              if (recoveredRemovalResult) {
                removalResult = recoveredRemovalResult
                removalCompleted = true
              } else if (isOrphanedWorktreeError(error)) {
                // If git no longer tracks this worktree, clean up the directory and metadata
                console.warn(
                  `[worktrees] Orphaned worktree detected at ${canonicalWorktreePath}, cleaning up`
                )
                const access = getLocalWorktreePathAccess(localWorktreeGitOptions)
                if (
                  await canSafelyRemoveOrphanedWorktreeDirectory(
                    toLocalWorktreeRuntimePath(canonicalWorktreePath, localWorktreeGitOptions),
                    toLocalWorktreeRuntimePath(repo.path, localWorktreeGitOptions),
                    access.statPath,
                    access.readPath
                  )
                ) {
                  await runtime.closeFileWatchersForRemoval(canonicalWorktreePath)
                  await removeLocalWorktreePath(
                    canonicalWorktreePath,
                    localWorktreeGitOptions
                  ).catch(() => {})
                } else {
                  console.warn(
                    `[worktrees] Refusing recursive cleanup for unproven worktree directory: ${canonicalWorktreePath}`
                  )
                }
                // Why: remove failed so git still tracks it (.git/worktrees/<name>); prune or the stale entry keeps its branch locked.
                await gitExecFileAsync(['worktree', 'prune'], {
                  cwd: repo.path,
                  ...localWorktreeGitOptions
                }).catch(() => {})
                await cleanupUnusedWorktreePushTargetRemote(
                  repo.path,
                  args.worktreeId,
                  removedPushTarget,
                  store,
                  localWorktreeGitOptions
                )
                runtime.clearOptimisticReconcileToken(args.worktreeId)
                removeWorktreeMetadataAndTransientState(store, args.worktreeId, removalHostId)
                preservedBranchCleanupByWorktreeId.delete(args.worktreeId)
                invalidateAuthorizedRootsCache()
                notifyWorktreesChanged(mainWindow, repoId)
                removalCompleted = true
                return {}
              } else {
                throw new Error(
                  formatWorktreeRemovalError(error, canonicalWorktreePath, args.force ?? false)
                )
              }
            }
            removalCompleted = true
          } finally {
            await removalGate.finish(removalCompleted)
          }
          await cleanupUnusedWorktreePushTargetRemote(
            repo.path,
            args.worktreeId,
            removedPushTarget,
            store,
            localWorktreeGitOptions
          )
          rememberPreservedBranchCleanupTarget(
            args.worktreeId,
            removalResult,
            refreshedRegisteredWorktree.head,
            removedPushTarget
          )
          runtime.clearOptimisticReconcileToken(args.worktreeId)
          await withWorktreeRemoveStageSpan('metadata_purge', 'local', async () => {
            removeWorktreeMetadataAndTransientState(store, args.worktreeId, removalHostId)
          })
          await withWorktreeRemoveStageSpan('cache_invalidation', 'local', async () => {
            invalidateAuthorizedRootsCache()
          })

          notifyWorktreesChanged(mainWindow, repoId)
          return removalResult ?? {}
        })
      })()
      worktreeRemovalsInFlight.set(inFlightKey, { optionsKey, promise: removal })
      try {
        const result = await removal
        options?.onWorktreeLifecycle?.({
          kind: 'removed',
          worktreeId: args.worktreeId,
          path: parseWorktreeId(args.worktreeId).worktreePath
        })
        return result
      } finally {
        if (worktreeRemovalsInFlight.get(inFlightKey)?.promise === removal) {
          worktreeRemovalsInFlight.delete(inFlightKey)
        }
      }
    }
  )

  // Why: drop a workspace locally with no remote work, so one pinned to a dead SSH target (where worktrees:remove throws) can still be cleared.
  ipcMain.handle(
    'worktrees:forgetLocal',
    async (
      _event,
      args: Pick<RemoveWorktreeArgs, 'worktreeId' | 'hostId'>
    ): Promise<RemoveWorktreeResult> => {
      const { repoId } = parseWorktreeId(args.worktreeId)
      const repo = getRepoForWorktreeRemoval(store, repoId, args.hostId)
      // Repo-first (unlike owner resolution below) so this key matches worktrees:remove's; meta only covers ownerless forgets.
      const inFlightKey = getWorktreeRemovalInFlightKey(
        args.worktreeId,
        repo
          ? getRepoExecutionHostId(repo)
          : (store.getWorktreeMeta(args.worktreeId)?.hostId ?? args.hostId)
      )
      const optionsKey = 'forget-local'
      const inFlight = worktreeRemovalsInFlight.get(inFlightKey)
      if (inFlight) {
        if (inFlight.optionsKey === optionsKey) {
          return inFlight.promise
        }
        throw new Error(`Worktree deletion already in progress: ${args.worktreeId}`)
      }

      const forget = (async (): Promise<RemoveWorktreeResult> => {
        // Ambiguous repo lookup must not bypass a live folder root's deletion guard.
        const isFolderRootOf = (candidate: Repo): boolean =>
          isFolderRepo(candidate) && args.worktreeId === getFolderWorkspaceRootId(candidate)
        if (repo ? isFolderRootOf(repo) : store.getRepos().some(isFolderRootOf)) {
          throw new Error(
            'Cannot delete the project root workspace. Remove the folder project instead.'
          )
        }

        const ownerHostId = resolveWorktreeRemovalOwnerHostId(
          store,
          args.worktreeId,
          repo,
          args.hostId
        )
        const ownerHost = parseExecutionHostId(ownerHostId)
        const sshPtyProvider =
          ownerHost?.kind === 'ssh' ? getSshPtyProvider(ownerHost.targetId) : undefined
        const externalHost = ownerHost?.kind === 'ssh' || ownerHost?.kind === 'runtime'
        // External host inventories must never sweep a same-id local workspace.
        await killAllProcessesForWorktree(args.worktreeId, {
          runtime,
          resolvedWorktreeId: args.worktreeId,
          ...(ownerHost?.kind === 'ssh' ? { resolvedConnectionId: ownerHost.targetId } : {}),
          ...(ownerHost?.kind === 'runtime'
            ? { resolvedRuntimeEnvironmentId: ownerHost.environmentId }
            : {}),
          localProvider: sshPtyProvider ?? getLocalPtyProvider(),
          onPtyStopped: clearProviderPtyState,
          ...(externalHost
            ? {
                includeProviderInventory: ownerHost?.kind === 'ssh' && Boolean(sshPtyProvider),
                includeLocalRegistry: false
              }
            : {})
        }).catch((err) => {
          console.warn(`[worktree-teardown] forget-local failed for ${args.worktreeId}:`, err)
        })

        runtime.clearOptimisticReconcileToken(args.worktreeId)
        // The resolved owner, not args.hostId: an orphan forget with no hostId still has to purge its SSH/runtime partition.
        removeWorktreeMetadataAndTransientState(store, args.worktreeId, ownerHost?.id)
        // Why: cached roots outlive the forgotten workspace, so an ownerless path stays filesystem-authorized until a rebuild.
        invalidateAuthorizedRootsCache()
        preservedBranchCleanupByWorktreeId.delete(args.worktreeId)
        notifyWorktreesChanged(mainWindow, repoId)
        return {}
      })()
      worktreeRemovalsInFlight.set(inFlightKey, { optionsKey, promise: forget })
      try {
        return await forget
      } finally {
        if (worktreeRemovalsInFlight.get(inFlightKey)?.promise === forget) {
          worktreeRemovalsInFlight.delete(inFlightKey)
        }
      }
    }
  )

  ipcMain.handle(
    'worktrees:forceDeletePreservedBranch',
    async (
      _event,
      args: { worktreeId: string; branchName: string; expectedHead: string }
    ): Promise<ForceDeleteWorktreeBranchResult> => {
      const { repoId } = parseWorktreeId(args.worktreeId)
      const cleanupTarget = getPreservedBranchCleanupTarget(
        args.worktreeId,
        args.branchName,
        args.expectedHead
      )
      const repo = store.getRepo(repoId)
      if (!repo) {
        throw new Error(`Repo not found: ${repoId}`)
      }
      if (isFolderRepo(repo)) {
        throw new Error('Folder workspaces do not have local Git branches.')
      }

      if (repo.connectionId) {
        const provider = requireSshGitProvider(repo.connectionId)
        // Why: SSH needs the write-capable relay RPC; the read-only git.exec allowlist rejects these worktree/update-ref/config writes.
        await provider.forceDeletePreservedBranch(
          repo.path,
          cleanupTarget.branchName,
          cleanupTarget.head
        )
        await cleanupUnusedWorktreePushTargetRemoteSsh(
          provider,
          repo.path,
          args.worktreeId,
          cleanupTarget.pushTarget,
          store
        )
      } else {
        const localWorktreeGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
        const hasLocalWorktreeGitOptions = Object.keys(localWorktreeGitOptions).length > 0
        await (hasLocalWorktreeGitOptions
          ? forceDeleteLocalBranch(
              repo.path,
              cleanupTarget.branchName,
              cleanupTarget.head,
              (argv, cwd) => gitExecFileAsync(argv, { cwd, ...localWorktreeGitOptions })
            )
          : forceDeleteLocalBranch(repo.path, cleanupTarget.branchName, cleanupTarget.head))
        await cleanupUnusedWorktreePushTargetRemote(
          repo.path,
          args.worktreeId,
          cleanupTarget.pushTarget,
          store,
          localWorktreeGitOptions
        )
      }

      preservedBranchCleanupByWorktreeId.delete(args.worktreeId)
      return { deleted: true }
    }
  )

  ipcMain.handle(
    'worktrees:updateMeta',
    (_event, args: { worktreeId: string; updates: Partial<WorktreeMeta> }) => {
      const validatedUpdates = normalizeLinkedWorkItemFields(args.updates)
      const updates =
        validatedUpdates.displayName !== undefined
          ? {
              ...validatedUpdates,
              pendingFirstAgentMessageRename: false,
              firstAgentMessageRenameError: null
            }
          : validatedUpdates
      const meta = store.setWorktreeMeta(args.worktreeId, stripOrcaProvenanceMetaUpdates(updates))
      // Do NOT notify here: renderer already applied this optimistically; a notification would re-sort the sidebar (bug PR #209).
      if (args.updates.displayName !== undefined) {
        // Why: remote clients have no optimistic rename and stopped polling titles, so push a remote-only invalidation; gate on displayName so per-click isUnread updates stay event-free.
        runtime.notifyWorktreesChangedForRemoteClients(getRepoIdFromWorktreeId(args.worktreeId))
      }
      return meta
    }
  )

  ipcMain.handle('worktrees:listLineage', async () => {
    await runtime.hydrateInferredWorktreeLineage()
    return {
      lineage: store.getAllWorktreeLineage(),
      workspaceLineage: store.getAllWorkspaceLineage()
    }
  })

  ipcMain.handle(
    'worktrees:listLineageForHost',
    (_event, args: ListDesktopLineageForHostArgs): Promise<HostLineageSnapshot> =>
      listDesktopLineageForHost(store, runtime, args)
  )

  ipcMain.handle(
    'worktrees:updateLineage',
    async (_event, args: { worktreeId: string; parentWorktreeId?: string; noParent?: boolean }) => {
      await runtime.updateManagedWorktreeMeta(args.worktreeId, {
        lineage:
          args.noParent === true
            ? { noParent: true }
            : args.parentWorktreeId
              ? { parentWorktree: `id:${args.parentWorktreeId}` }
              : undefined
      })
      notifyWorktreesChanged(mainWindow, parseWorktreeId(args.worktreeId).repoId)
      return store.getWorktreeLineage(args.worktreeId) ?? null
    }
  )

  // Why: snapshot sidebar order for cold-start restore (ephemeral signals gone); one batch call avoids N updateMeta IPCs.
  ipcMain.handle('worktrees:persistSortOrder', (_event, args: { orderedIds: string[] }) => {
    if (!Array.isArray(args?.orderedIds) || args.orderedIds.length === 0) {
      return
    }
    const now = Date.now()
    for (let i = 0; i < args.orderedIds.length; i++) {
      // Why: a sidebar-order snapshot must only reorder worktrees that already
      // exist — it must never create one. Without this guard a stale id the
      // renderer still lists (e.g. a removed repo's `${repoId}::${path}`) gets a
      // fresh worktreeMeta entry minted here, resurrecting an orphan/duplicate
      // workspace on the next launch. setWorktreeMeta has no repo-existence check.
      if (!store.getWorktreeMeta(args.orderedIds[i])) {
        continue
      }
      // Descending timestamps: first item gets highest sortOrder so b - a sorts first-wins on cold start.
      store.setWorktreeMeta(args.orderedIds[i], { sortOrder: now - i * 1000 })
    }
  })

  // Why: full failure output lives only in main memory (not worktree metadata), so the dialog pulls it on demand.
  ipcMain.handle(
    'worktrees:getBranchRenameFailureOutput',
    (_event, args: { worktreeId: string }) => {
      if (typeof args?.worktreeId !== 'string' || args.worktreeId.length === 0) {
        return null
      }
      return readBranchRenameFailureOutputForDisplay(args.worktreeId)
    }
  )

  ipcMain.handle(
    'hooks:check',
    async (_event, args: { repoId: string; hostId?: ExecutionHostId }) => {
      const repo = getRepoForWorktreeRemoval(store, args.repoId, args.hostId)
      if (!repo) {
        const repoIdExists = store.getRepos().some((candidate) => candidate.id === args.repoId)
        // Why: callers treat inspection errors as "skip", so a requested/ambiguous host must report error (fail closed), not hook-free.
        return {
          status: args.hostId || repoIdExists ? 'error' : 'ok',
          hasHooks: false,
          hooks: null,
          mayNeedUpdate: false
        }
      }
      if (isFolderRepo(repo)) {
        return { status: 'ok', hasHooks: false, hooks: null, mayNeedUpdate: false }
      }

      if (repo.connectionId) {
        const fsProvider = getSshFilesystemProvider(repo.connectionId)
        if (!fsProvider) {
          return { status: 'error', hasHooks: false, hooks: null, mayNeedUpdate: false }
        }
        try {
          const result = await fsProvider.readFile(joinWorktreeRelativePath(repo.path, 'orca.yaml'))
          return {
            status: 'ok',
            hasHooks: !result.isBinary,
            hooks: result.isBinary ? null : parseOrcaYaml(result.content),
            mayNeedUpdate: false
          }
        } catch (error) {
          return {
            status: isENOENT(error) ? 'ok' : 'error',
            hasHooks: false,
            hooks: null,
            mayNeedUpdate: false
          }
        }
      }

      const has = hasHooksFile(repo.path)
      const hooks = has ? loadHooks(repo.path) : null
      // Why: unrecognised top-level keys mean the file is well-formed but from a newer Orca; suggest updating rather than "could not be parsed".
      const mayNeedUpdate = has && !hooks && hasUnrecognizedOrcaYamlKeys(repo.path)
      return {
        status: 'ok',
        hasHooks: has,
        hooks,
        mayNeedUpdate
      }
    }
  )

  ipcMain.handle(
    'hooks:createIssueCommandRunner',
    (_event, args: { repoId: string; worktreePath: string; command: string }) => {
      const repo = store.getRepo(args.repoId)
      if (!repo) {
        throw new Error(`Repo not found: ${args.repoId}`)
      }

      return createIssueCommandRunnerScript(
        repo,
        args.worktreePath,
        args.command,
        getLocalProjectWorktreeGitOptions(store, repo),
        resolveSetupRunnerShell(store.getSettings())
      )
    }
  )

  ipcMain.handle(
    'hooks:inspectSetupScriptImports',
    async (_event, args: { repoId: string; hostId?: ExecutionHostId }) => {
      const repo = getRepoForWorktreeRemoval(store, args.repoId, args.hostId)
      if (!repo || isFolderRepo(repo)) {
        return []
      }

      return inspectSetupScriptImportCandidates(
        async (relativePath) => {
          const filePath = joinWorktreeRelativePath(repo.path, relativePath)
          if (repo.connectionId) {
            const fsProvider = getSshFilesystemProvider(repo.connectionId)
            if (!fsProvider) {
              return null
            }
            try {
              const result = await fsProvider.readFile(filePath)
              return result.isBinary ? null : result.content
            } catch {
              return null
            }
          }

          try {
            return await readFile(filePath, 'utf-8')
          } catch (error) {
            if (!isENOENT(error)) {
              console.warn('[hooks] Failed to inspect setup script import candidate:', error)
            }
            return null
          }
        },
        {
          fileExists: async (relativePath) => {
            const filePath = joinWorktreeRelativePath(repo.path, relativePath)
            if (repo.connectionId) {
              const fsProvider = getSshFilesystemProvider(repo.connectionId)
              if (!fsProvider) {
                return false
              }
              try {
                const fileStat = await fsProvider.stat(filePath)
                return fileStat.type !== 'directory'
              } catch {
                return false
              }
            }

            try {
              const fileStat = await stat(filePath)
              return !fileStat.isDirectory()
            } catch (error) {
              if (!isENOENT(error)) {
                console.warn('[hooks] Failed to stat setup script import candidate:', error)
              }
              return false
            }
          }
        }
      )
    }
  )

  ipcMain.handle(
    'hooks:readIssueCommand',
    async (_event, args: { repoId: string; hostId?: ExecutionHostId }) => {
      const repo = getRepoForWorktreeRemoval(store, args.repoId, args.hostId)
      if (!repo || isFolderRepo(repo)) {
        return {
          status: 'ok',
          localContent: null,
          sharedContent: null,
          effectiveContent: null,
          localFilePath: '',
          source: 'none' as const
        }
      }
      if (repo.connectionId) {
        const issueCommandPath = joinWorktreeRelativePath(repo.path, '.orca/issue-command')
        const fsProvider = getSshFilesystemProvider(repo.connectionId)
        if (!fsProvider) {
          return {
            status: 'error',
            localContent: null,
            sharedContent: null,
            effectiveContent: null,
            localFilePath: issueCommandPath,
            source: 'none' as const
          }
        }

        let status: 'ok' | 'error' = 'ok'
        let localContent: string | null = null
        let sharedContent: string | null = null
        try {
          const result = await fsProvider.readFile(issueCommandPath)
          localContent = result.isBinary ? null : result.content.trim() || null
        } catch (error) {
          if (!isENOENT(error)) {
            status = 'error'
          }
        }
        try {
          const result = await fsProvider.readFile(joinWorktreeRelativePath(repo.path, 'orca.yaml'))
          sharedContent = result.isBinary
            ? null
            : parseOrcaYaml(result.content)?.issueCommand?.trim() || null
        } catch (error) {
          if (!isENOENT(error)) {
            status = 'error'
          }
        }
        const effectiveContent = localContent ?? sharedContent
        return {
          status: localContent ? 'ok' : status,
          localContent,
          sharedContent,
          effectiveContent,
          localFilePath: issueCommandPath,
          source: localContent
            ? ('local' as const)
            : sharedContent
              ? ('shared' as const)
              : ('none' as const)
        }
      }
      return readIssueCommand(repo.path)
    }
  )

  ipcMain.handle(
    'hooks:writeIssueCommand',
    async (_event, args: { repoId: string; content: string; hostId?: ExecutionHostId }) => {
      const repo = getRepoForWorktreeRemoval(store, args.repoId, args.hostId)
      if (!repo || isFolderRepo(repo)) {
        return
      }
      if (repo.connectionId) {
        const issueCommandPath = joinWorktreeRelativePath(repo.path, '.orca/issue-command')
        const fsProvider = getSshFilesystemProvider(repo.connectionId)
        if (!fsProvider) {
          throw new Error(
            'Remote filesystem unavailable. Reconnect the SSH target before retrying.'
          )
        }
        const trimmed = args.content.trim()
        if (!trimmed) {
          await fsProvider.deletePath(issueCommandPath, false).catch((error: unknown) => {
            if (!isENOENT(error)) {
              throw error
            }
          })
          return
        }
        await fsProvider.createDir(joinWorktreeRelativePath(repo.path, '.orca'))
        const gitignorePath = joinWorktreeRelativePath(repo.path, '.gitignore')
        try {
          const result = await fsProvider.readFile(gitignorePath)
          if (!result.isBinary && !/^\.orca\/?$/m.test(result.content)) {
            const separator = result.content.endsWith('\n') ? '' : '\n'
            await fsProvider.writeFile(gitignorePath, `${result.content}${separator}.orca\n`)
          }
        } catch (error) {
          if (!isENOENT(error)) {
            throw error
          }
          await fsProvider.writeFile(gitignorePath, '.orca\n')
        }
        await fsProvider.writeFile(issueCommandPath, `${trimmed}\n`)
        return
      }
      writeIssueCommand(repo.path, args.content)
    }
  )
}
