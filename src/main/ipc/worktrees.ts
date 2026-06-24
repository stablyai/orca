/* oxlint-disable max-lines */
import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { readFile, stat } from 'fs/promises'
import { randomUUID } from 'crypto'
import type { Store } from '../persistence'
import { isFolderRepo } from '../../shared/repo-kind'
import {
  isWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../shared/workspace-scope'
import { inspectSetupScriptImportCandidates } from '../../shared/setup-script-imports'
import { getProjectHostSetupWorktreeMeta } from '../../shared/project-host-setup-projection'
import { deleteWorktreeHistoryDir } from '../terminal-history'
import type {
  AutomationWorkspaceProvenance,
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
  WorktreeMeta
} from '../../shared/types'
import {
  buildKnownOrcaWorkspaceLayouts,
  isLegacyRepoForExternalWorktreeVisibility,
  toDetectedWorktree
} from '../../shared/worktree-ownership'
import {
  assertWorktreeCleanForRemoval,
  forceDeleteLocalBranch,
  listWorktreesStrict as listGitWorktreesStrict,
  removeWorktree
} from '../git/worktree'
import { gitExecFileAsync } from '../git/runner'
import { withWorktreeSpan } from '../observability/instrumentation'
import { resolveGitHubPrStartPoint } from '../github/pr-start-point'
import { fetchPrHeadTrackingRef } from '../github/pr-head-tracking-ref'
import { getDefaultRemote } from '../git/repo'
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
import { closeLocalWatcherForWorktreePath } from './filesystem-watcher'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { killAllProcessesForWorktree } from '../runtime/worktree-teardown'
import { clearProviderPtyState, getLocalPtyProvider } from './pty'
import { removeWorktreeLinkedPaths } from './worktree-symlinks'
import { track } from '../telemetry/client'
import { getCohortAtEmit } from '../telemetry/cohort-classifier'
import { workspaceSourceSchema, type WorkspaceSource } from '../../shared/telemetry-events'
import {
  finishAutomationWorkspaceProvenanceRequest,
  releaseAutomationWorkspaceProvenanceRequest,
  resolveAutomationWorkspaceProvenance
} from '../automations/workspace-provenance'

type CreateWorktreeArgsWithSystemProvenance = CreateWorktreeArgs & {
  automationProvenance?: AutomationWorkspaceProvenance
}
import { classifyWorkspaceCreateError } from './workspace-create-error-classifier'
import { advertisedUrlWatcher } from '../ports/advertised-url-watcher'
import {
  assertWorktreeDoesNotContainRegisteredWorktree,
  canCleanupUnregisteredOrcaWorktreeDirectory,
  canSafelyRemoveOrphanedWorktreeDirectory,
  findRegisteredDeletableWorktree,
  isWorktreePathMissing,
  ORPHANED_WORKTREE_DIRECTORY_MESSAGE,
  stripOrcaProvenanceMetaUpdates,
  UNREGISTERED_MISSING_WORKTREE_MESSAGE
} from '../worktree-removal-safety'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { DEFAULT_WORKSPACE_STATUS_ID } from '../../shared/workspace-statuses'
import {
  FOLDER_WORKSPACE_INSTANCE_SEPARATOR,
  makeLegacyWorktreeId,
  makeRepoWorktreeKey,
  parseWorktreeKey
} from '../../shared/worktree-id'
import { getRepoExecutionHostId, normalizeExecutionHostId } from '../../shared/execution-host'
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

const WORKTREE_ARCHIVE_HOOK_TIMEOUT_MS = 120_000
const WORKTREE_LIST_ALL_CONCURRENCY = 8

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

function removeWorktreeMetadataAndTransientState(store: Store, worktreeId: string): void {
  // Why: worktree IDs are path-derived and can be recreated, so removal must
  // drop process-local caches before the same ID can point at a new workspace.
  store.removeWorktreeMeta(worktreeId)
  advertisedUrlWatcher.forgetWorktree(worktreeId)
  deleteWorktreeHistoryDir(worktreeId)
}

async function closeLocalWatcherForRemoval(worktreePath: string): Promise<void> {
  await closeLocalWatcherForWorktreePath(worktreePath).catch((err) => {
    console.warn(`[filesystem-watcher] failed to close ${worktreePath}:`, err)
  })
}

function dedupeGitWorktreesByPath(gitWorktrees: GitWorktreeInfo[]): GitWorktreeInfo[] {
  const uniqueGitWorktrees: GitWorktreeInfo[] = []
  for (const gitWorktree of gitWorktrees) {
    if (
      uniqueGitWorktrees.some((existing) => areWorktreePathsEqual(existing.path, gitWorktree.path))
    ) {
      continue
    }
    uniqueGitWorktrees.push(gitWorktree)
  }
  return uniqueGitWorktrees
}

function getRepoWorktreeId(
  repo: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>,
  path: string
): string {
  return makeRepoWorktreeKey(repo, path)
}

function getRepoLegacyWorktreeId(repo: Pick<Repo, 'id'>, path: string): string {
  return makeLegacyWorktreeId(repo.id, path)
}

function getWorktreeRemovalIdAliases(
  store: Store,
  repos: Repo[],
  repo: Repo,
  worktreePath: string,
  requestedId: string
): string[] {
  const canonicalId = getRepoWorktreeId(repo, worktreePath)
  const legacyId = getRepoLegacyWorktreeId(repo, worktreePath)
  const ids = new Set([canonicalId, requestedId])
  const legacyMeta = store.getWorktreeMeta(legacyId)
  const repoHostId = getRepoExecutionHostId(repo)
  const requestedLegacyId = requestedId === legacyId
  const legacyBelongsToRepoHost = legacyMeta?.hostId === repoHostId
  const legacySafeWithoutMeta = legacyMeta === undefined
  const legacyUnambiguous = !hasAmbiguousRepoHost(repos, repo)
  if (requestedLegacyId || legacyBelongsToRepoHost || legacySafeWithoutMeta || legacyUnambiguous) {
    ids.add(legacyId)
  }
  return [...ids]
}

function getRemovalWorktreeMeta(
  store: Store,
  worktreeIds: readonly string[]
): WorktreeMeta | undefined {
  for (const worktreeId of worktreeIds) {
    const meta = store.getWorktreeMeta(worktreeId)
    if (meta) {
      return meta
    }
  }
  return undefined
}

function removeWorktreeAliasesMetadataAndTransientState(
  store: Store,
  worktreeIds: readonly string[]
): void {
  for (const worktreeId of worktreeIds) {
    removeWorktreeMetadataAndTransientState(store, worktreeId)
  }
}

function migrateLegacyWorktreeMetaIfSafe(
  store: Store,
  repos: Repo[],
  repo: Repo,
  path: string
): void {
  const canonicalId = getRepoWorktreeId(repo, path)
  if (store.getWorktreeMeta(canonicalId)) {
    return
  }
  const legacyId = getRepoLegacyWorktreeId(repo, path)
  const legacyMeta = store.getWorktreeMeta(legacyId)
  if (!legacyMeta) {
    return
  }
  const repoHostId = getRepoExecutionHostId(repo)
  if (legacyMeta.hostId !== undefined && legacyMeta.hostId !== repoHostId) {
    return
  }
  if (legacyMeta.hostId === undefined && hasAmbiguousRepoHost(repos, repo)) {
    return
  }
  store.migrateWorktreeIdentity(legacyId, canonicalId)
}

function isCanonicalWorktreeIdForRepoHost(repo: Repo, worktreeId: string): boolean {
  const parsed = parseWorktreeKey(worktreeId)
  return parsed?.repoId === repo.id && parsed.hostId === getRepoExecutionHostId(repo)
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
    // Why: project IDs can be upgraded from legacy repo IDs to provider-backed
    // logical IDs. If the host setup is the same, repair ownership on discovery.
    ...(sameSetup && existing?.projectId !== ownership.projectId
      ? { projectId: ownership.projectId }
      : {}),
    ...(sameSetup && existing?.hostId !== ownership.hostId ? { hostId: ownership.hostId } : {}),
    ...(existing?.projectHostSetupId === undefined
      ? { projectHostSetupId: ownership.projectHostSetupId }
      : {})
  }
}

// Why: worktrees discovered on disk (not created via Orca's UI) have no
// persisted WorktreeMeta, so mergeWorktree falls back to `lastActivityAt: 0`.
// That makes them sort to the bottom of "Recent" even though the user just
// added the repo / folder. The same authoritative discovery pass is also the
// safest time to backfill project-host setup ownership for upgraded profiles.
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
      // Why: profiles created before lineage shipped already have WorktreeMeta
      // rows. Backfill on authoritative discovery so upgraded workspaces can
      // immediately participate in instance-validated lineage and host routing.
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

function getWorktreeRemovalOptionsKey(args: { force?: boolean; skipArchive?: boolean }): string {
  const forceKey = args.force === true ? 'force' : 'normal'
  const archiveKey = args.skipArchive === true ? 'skip-archive' : 'run-archive'
  return `${forceKey}:${archiveKey}`
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
  worktreeIds: string | readonly string[],
  result: RemoveWorktreeResult | undefined,
  fallbackHead: string | undefined,
  pushTarget: GitPushTarget | undefined
): void {
  const ids = typeof worktreeIds === 'string' ? [worktreeIds] : worktreeIds
  if (result?.preservedBranch) {
    const head = result.preservedBranch.head ?? fallbackHead
    if (!head) {
      throw new Error(
        `Cannot safely offer force-delete for preserved branch "${result.preservedBranch.branchName}" without its saved commit.`
      )
    }
    for (const worktreeId of ids) {
      preservedBranchCleanupByWorktreeId.set(worktreeId, {
        branchName: result.preservedBranch.branchName,
        head,
        ...(pushTarget ? { pushTarget } : {})
      })
    }
    return
  }
  for (const worktreeId of ids) {
    preservedBranchCleanupByWorktreeId.delete(worktreeId)
  }
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
// Why: absorb renderer polling bursts while keeping external worktree-change
// lag bounded to one short refresh window.
const DETECTED_WORKTREE_SCAN_CACHE_TTL_MS = 5_000

type DetectedWorktreeScanCacheEntry = {
  expiresAt: number
  worktrees: GitWorktreeInfo[]
}

type DetectedWorktreeScanResult = {
  gitWorktrees: GitWorktreeInfo[]
  fresh: boolean
}

const detectedWorktreeScanCache = new Map<string, DetectedWorktreeScanCacheEntry>()
const detectedWorktreeScanInFlight = new Map<string, Promise<GitWorktreeInfo[]>>()
const detectedWorktreeScanGenerations = new Map<string, number>()

function getDetectedWorktreeScanCacheKey(repo: Repo): string {
  return JSON.stringify({
    repoId: repo.id,
    hostId: getRepoExecutionHostId(repo),
    path: repo.path
  })
}

function isDetectedWorktreeScanCacheKeyForRepo(cacheKey: string, repoId: string): boolean {
  try {
    return (JSON.parse(cacheKey) as { repoId?: unknown }).repoId === repoId
  } catch {
    return false
  }
}

function invalidateDetectedWorktreeScanCache(repoId: string): void {
  for (const key of detectedWorktreeScanCache.keys()) {
    if (isDetectedWorktreeScanCacheKeyForRepo(key, repoId)) {
      detectedWorktreeScanCache.delete(key)
    }
  }
  for (const key of detectedWorktreeScanInFlight.keys()) {
    if (isDetectedWorktreeScanCacheKeyForRepo(key, repoId)) {
      detectedWorktreeScanInFlight.delete(key)
    }
  }
  detectedWorktreeScanGenerations.set(
    repoId,
    (detectedWorktreeScanGenerations.get(repoId) ?? 0) + 1
  )
}

registerWorktreeChangeInvalidator(invalidateDetectedWorktreeScanCache)

export function __resetDetectedWorktreeScanCacheForTests(): void {
  detectedWorktreeScanCache.clear()
  detectedWorktreeScanInFlight.clear()
  detectedWorktreeScanGenerations.clear()
}

async function listDetectedGitWorktrees(
  store: Store,
  repo: Repo
): Promise<DetectedWorktreeScanResult> {
  if (repo.connectionId || isFolderRepo(repo)) {
    return {
      gitWorktrees: await listRepoWorktrees(repo, getLocalProjectWorktreeGitOptions(store, repo)),
      fresh: true
    }
  }

  const cacheKey = getDetectedWorktreeScanCacheKey(repo)
  const cached = detectedWorktreeScanCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return { gitWorktrees: cached.worktrees, fresh: false }
  }

  const inFlight = detectedWorktreeScanInFlight.get(cacheKey)
  if (inFlight) {
    return { gitWorktrees: await inFlight, fresh: false }
  }

  const scan = listRepoWorktrees(repo, getLocalProjectWorktreeGitOptions(store, repo))
  const generation = detectedWorktreeScanGenerations.get(repo.id) ?? 0
  detectedWorktreeScanInFlight.set(cacheKey, scan)
  try {
    const gitWorktrees = await scan
    // Why: a create/remove notification can invalidate while the git scan is
    // still running. Do not let that stale scan repopulate the cache afterward.
    const isCurrentGeneration = (detectedWorktreeScanGenerations.get(repo.id) ?? 0) === generation
    if (isCurrentGeneration) {
      detectedWorktreeScanCache.set(cacheKey, {
        worktrees: gitWorktrees,
        expiresAt: Date.now() + DETECTED_WORKTREE_SCAN_CACHE_TTL_MS
      })
    }
    return { gitWorktrees, fresh: isCurrentGeneration }
  } finally {
    if (detectedWorktreeScanInFlight.get(cacheKey) === scan) {
      detectedWorktreeScanInFlight.delete(cacheKey)
    }
  }
}

function warnOnce(keySet: Set<string>, key: string, message: string, error?: unknown): void {
  if (keySet.has(key)) {
    return
  }
  keySet.add(key)
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
  // Why: worktrees:list already paid the `git worktree list` cost. Reusing
  // that result keeps later git/file IPC validation from doing a second
  // background scan that can trigger macOS folder-permission prompts.
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
  const liveIds = new Set(gitWorktrees.map((worktree) => getRepoWorktreeId(repo, worktree.path)))
  const legacyLiveIds = new Set(
    gitWorktrees.map((worktree) => getRepoLegacyWorktreeId(repo, worktree.path))
  )
  const repoPrefix = `${repo.id}::`
  for (const childWorkspaceKey of Object.keys(store.getAllWorkspaceLineage?.() ?? {})) {
    const childScope = parseWorkspaceKey(childWorkspaceKey)
    if (
      childScope?.type === 'worktree' &&
      childScope.worktreeId.startsWith(repoPrefix) &&
      !legacyLiveIds.has(childScope.worktreeId)
    ) {
      if (isWorkspaceKey(childWorkspaceKey)) {
        store.removeWorkspaceLineage?.(childWorkspaceKey)
      }
    }
  }
  for (const [childId, lineage] of Object.entries(store.getAllWorktreeLineage())) {
    if (
      (childId.startsWith(repoPrefix) && !legacyLiveIds.has(childId)) ||
      (isCanonicalWorktreeIdForRepoHost(repo, childId) && !liveIds.has(childId))
    ) {
      // Why: path-derived IDs can disappear and later be reused by a different
      // checkout. Once a successful scan proves the child is gone, drop its
      // lineage so a future same-path worktree cannot inherit it. Missing
      // parents stay readable so the UI can show the repairable "Missing
      // parent" state.
      store.removeWorktreeLineage(childId)
      store.removeWorkspaceLineage?.(worktreeWorkspaceKey(childId))
    }
    const parentMissingFromLegacyScan =
      lineage.parentWorktreeId.startsWith(repoPrefix) &&
      !legacyLiveIds.has(lineage.parentWorktreeId)
    const parentMissingFromCanonicalScan =
      isCanonicalWorktreeIdForRepoHost(repo, lineage.parentWorktreeId) &&
      !liveIds.has(lineage.parentWorktreeId)
    if (parentMissingFromLegacyScan || parentMissingFromCanonicalScan) {
      const parentMeta = store.getWorktreeMeta(lineage.parentWorktreeId)
      if (!parentMeta || parentMeta.instanceId === lineage.parentWorktreeInstanceId) {
        // Why: keep the child lineage so the UI can show "Missing parent", but
        // rotate the absent parent's stale identity once. If a different
        // checkout later reuses that path, the old lineage stays invalid.
        store.setWorktreeMeta(lineage.parentWorktreeId, { instanceId: randomUUID() })
      }
    }
  }
}

type SshWorktreeMetaCandidate = {
  id: string
  hostId?: string
  path: string
  meta: WorktreeMeta
}

type SshWorktreeMetaIndex = Map<string, SshWorktreeMetaCandidate[]>

function createSshWorktreeMetaIndex(entries: [string, WorktreeMeta][]): SshWorktreeMetaIndex {
  const index: SshWorktreeMetaIndex = new Map()
  for (const [worktreeId, meta] of entries) {
    let parsed: { repoId: string; worktreePath: string; hostId?: string }
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
    candidates.push({ id: worktreeId, hostId: parsed.hostId, path: parsed.worktreePath, meta })
    index.set(parsed.repoId, candidates)
  }
  return index
}

function hasAmbiguousRepoHost(repos: Repo[], repo: Repo): boolean {
  const hostIds = new Set(
    repos
      .filter((candidateRepo) => candidateRepo.id === repo.id)
      .map((candidateRepo) => getRepoExecutionHostId(candidateRepo))
  )
  return hostIds.size > 1
}

function getRepoForWorktreeRemoval(
  store: Store,
  parsed: { repoId: string; hostId?: string }
): Repo | undefined {
  const repos = store.getRepos()
  const matchingRepos = repos.filter((repo) => repo.id === parsed.repoId)
  const fallbackRepo = store.getRepo(parsed.repoId)
  if (parsed.hostId !== undefined) {
    if (fallbackRepo && getRepoExecutionHostId(fallbackRepo) === parsed.hostId) {
      return fallbackRepo
    }
    return matchingRepos.find((candidate) => getRepoExecutionHostId(candidate) === parsed.hostId)
  }
  if (matchingRepos.length === 0) {
    return fallbackRepo
  }
  const hostIds = new Set(matchingRepos.map((repo) => getRepoExecutionHostId(repo)))
  // Why: legacy repo-id-only requests are safe only when the repo id
  // belongs to exactly one execution host. Canonical IDs must carry hostId.
  if (hostIds.size !== 1) {
    return undefined
  }
  const [hostId] = hostIds
  return fallbackRepo && getRepoExecutionHostId(fallbackRepo) === hostId
    ? fallbackRepo
    : matchingRepos[0]
}

function getRepoForHostScopedRequest(
  store: Store,
  parsed: { repoId: string; hostId?: string }
): Repo | undefined {
  const fallbackRepo = store.getRepo(parsed.repoId)
  if (parsed.hostId === undefined) {
    return fallbackRepo
  }
  if (fallbackRepo && getRepoExecutionHostId(fallbackRepo) === parsed.hostId) {
    return fallbackRepo
  }
  return store
    .getRepos()
    .find(
      (candidate) =>
        candidate.id === parsed.repoId && getRepoExecutionHostId(candidate) === parsed.hostId
    )
}

function isSshWorktreeMetaCandidateForRepo(
  repos: Repo[],
  repo: Repo,
  candidate: SshWorktreeMetaCandidate
): boolean {
  const repoHostId = getRepoExecutionHostId(repo)
  if (candidate.hostId !== undefined) {
    return candidate.hostId === repoHostId
  }
  if (candidate.meta.hostId !== undefined) {
    return candidate.meta.hostId === repoHostId
  }
  return !hasAmbiguousRepoHost(repos, repo)
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
  repos: Repo[],
  repo: Repo,
  metaIndex: SshWorktreeMetaIndex
): ReturnType<typeof mergeWorktree>[] {
  const byWorktreeId = new Map<string, ReturnType<typeof mergeWorktree>>()
  for (const candidate of metaIndex.get(repo.id) ?? []) {
    if (!isSshWorktreeMetaCandidateForRepo(repos, repo, candidate)) {
      continue
    }
    migrateLegacyWorktreeMetaIfSafe(store, repos, repo, candidate.path)
    const canonicalId = getRepoWorktreeId(repo, candidate.path)
    const candidateMeta = store.getWorktreeMeta(canonicalId) ?? candidate.meta
    const ownershipUpdates = getProjectHostSetupMetaUpdates(store, repo, candidateMeta)
    const meta =
      Object.keys(ownershipUpdates).length > 0
        ? { ...candidateMeta, ...ownershipUpdates }
        : candidateMeta
    if (Object.keys(ownershipUpdates).length > 0) {
      store.setWorktreeMeta(canonicalId, ownershipUpdates)
    }
    const worktree = mergeWorktree(
      repo.id,
      synthesizeSshGitWorktree(repo, candidate.path, meta),
      meta,
      undefined,
      { hostId: getRepoExecutionHostId(repo) }
    )
    byWorktreeId.delete(worktree.id)
    byWorktreeId.set(worktree.id, worktree)
  }
  return [...byWorktreeId.values()]
}

function buildDetectedGitWorktrees(
  store: Store,
  repos: Repo[],
  repo: Repo,
  gitWorktrees: GitWorktreeInfo[]
): DetectedWorktree[] {
  const settings = store.getSettings()
  const knownOrcaLayouts = buildKnownOrcaWorkspaceLayouts(settings, repo)
  const isLegacyRepoForVisibility = isLegacyRepoForExternalWorktreeVisibility(repo)
  return dedupeGitWorktreesByPath(gitWorktrees).map((gitWorktree) => {
    migrateLegacyWorktreeMetaIfSafe(store, repos, repo, gitWorktree.path)
    const worktreeId = getRepoWorktreeId(repo, gitWorktree.path)
    let meta = store.getWorktreeMeta(worktreeId)
    const worktree = mergeWorktree(repo.id, gitWorktree, meta, repo.displayName, {
      hostId: getRepoExecutionHostId(repo)
    })
    const detected = toDetectedWorktree({
      repo,
      worktree,
      meta,
      settings,
      knownOrcaLayouts,
      isLegacyRepoForVisibility
    })
    if (!detected.visible) {
      return detected
    }

    meta = resolveWorktreeMetaWithDiscoveryBackfill(store, repo, worktreeId)
    return toDetectedWorktree({
      repo,
      worktree: mergeWorktree(repo.id, gitWorktree, meta, repo.displayName, {
        hostId: getRepoExecutionHostId(repo)
      }),
      meta,
      settings,
      knownOrcaLayouts,
      isLegacyRepoForVisibility
    })
  })
}

function stampAndMergeVisibleDetectedWorktree(
  store: Store,
  repos: Repo[],
  repo: Repo,
  detected: DetectedWorktree
) {
  migrateLegacyWorktreeMetaIfSafe(store, repos, repo, detected.path)
  const meta = resolveWorktreeMetaWithDiscoveryBackfill(store, repo, detected.id)
  return mergeWorktree(repo.id, detected, meta, repo.displayName, {
    hostId: getRepoExecutionHostId(repo)
  })
}

function getFolderWorkspaceRootId(repo: Repo): string {
  return getRepoWorktreeId(repo, repo.path)
}

function getFolderWorkspaceInstanceId(repo: Repo, instanceId: string): string {
  return `${getFolderWorkspaceRootId(repo)}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}${instanceId}`
}

function getLegacyFolderWorkspaceRootId(repo: Repo): string {
  return getRepoLegacyWorktreeId(repo, repo.path)
}

function getFolderWorkspaceInstanceIdentity(repo: Repo, worktreeId: string): string {
  const prefix = `${getFolderWorkspaceRootId(repo)}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}`
  const legacyPrefix = `${getLegacyFolderWorkspaceRootId(repo)}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}`
  if (worktreeId.startsWith(prefix)) {
    return worktreeId.slice(prefix.length)
  }
  return worktreeId.startsWith(legacyPrefix) ? worktreeId.slice(legacyPrefix.length) : randomUUID()
}

function isFolderWorkspaceIdForRepo(repo: Repo, worktreeId: string): boolean {
  const rootId = getFolderWorkspaceRootId(repo)
  return (
    worktreeId === rootId ||
    worktreeId.startsWith(`${rootId}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}`)
  )
}

function isLegacyFolderWorkspaceIdForRepo(repo: Repo, worktreeId: string): boolean {
  const rootId = getLegacyFolderWorkspaceRootId(repo)
  return (
    worktreeId === rootId ||
    worktreeId.startsWith(`${rootId}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}`)
  )
}

function isFolderWorkspaceRootIdForRepo(repo: Repo, worktreeId: string): boolean {
  return (
    worktreeId === getFolderWorkspaceRootId(repo) ||
    worktreeId === getLegacyFolderWorkspaceRootId(repo)
  )
}

function getCanonicalFolderWorkspaceId(repo: Repo, worktreeId: string): string {
  if (!isLegacyFolderWorkspaceIdForRepo(repo, worktreeId)) {
    return worktreeId
  }
  const instanceId = getFolderWorkspaceInstanceIdentity(repo, worktreeId)
  return worktreeId === getLegacyFolderWorkspaceRootId(repo)
    ? getFolderWorkspaceRootId(repo)
    : getFolderWorkspaceInstanceId(repo, instanceId)
}

function migrateLegacyFolderWorkspaceMetaIfSafe(store: Store, repo: Repo): void {
  const hasAmbiguousHost = hasAmbiguousRepoHost(store.getRepos(), repo)
  for (const [worktreeId, meta] of Object.entries(store.getAllWorktreeMeta())) {
    if (!isLegacyFolderWorkspaceIdForRepo(repo, worktreeId)) {
      continue
    }
    const repoHostId = getRepoExecutionHostId(repo)
    if (meta.hostId !== undefined && meta.hostId !== repoHostId) {
      continue
    }
    if (meta.hostId === undefined && hasAmbiguousHost) {
      continue
    }
    store.migrateWorktreeIdentity(worktreeId, getCanonicalFolderWorkspaceId(repo, worktreeId))
  }
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
    ...(meta.priorWorktreeIds !== undefined ? { priorWorktreeIds: meta.priorWorktreeIds } : {}),
    workspaceStatus: meta.workspaceStatus ?? DEFAULT_WORKSPACE_STATUS_ID,
    diffComments: meta.diffComments,
    mobileDiffReview: meta.mobileDiffReview
  }
}

function listFolderWorkspaces(store: Store, repo: Repo): Worktree[] {
  migrateLegacyFolderWorkspaceMetaIfSafe(store, repo)
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
    ...(args.linkedGiteaPR !== undefined ? { linkedGiteaPR: args.linkedGiteaPR } : {})
  })
  return { worktree: mergeFolderWorkspace(repo, worktreeId, meta) }
}

function buildDisconnectedDetectedWorktrees(
  store: Store,
  repo: Repo,
  worktrees: Worktree[]
): DetectedWorktree[] {
  const settings = store.getSettings()
  return worktrees.map((worktree) => {
    const meta = store.getWorktreeMeta(worktree.id)
    const detected = toDetectedWorktree({
      repo,
      worktree,
      meta,
      settings,
      knownOrcaLayouts: [],
      isLegacyRepoForVisibility: true
    })
    return {
      ...detected,
      visible: true,
      ownership: detected.ownership === 'orca-managed' ? 'orca-managed' : 'unknown-legacy'
    }
  })
}

export function registerWorktreeHandlers(
  mainWindow: BrowserWindow,
  store: Store,
  runtime: OrcaRuntimeService
): void {
  // Remove any previously registered handlers so we can re-register them
  // (e.g. when macOS re-activates the app and creates a new window).
  ipcMain.removeHandler('worktrees:listAll')
  ipcMain.removeHandler('worktrees:list')
  ipcMain.removeHandler('worktrees:listDetected')
  ipcMain.removeHandler('worktrees:create')
  ipcMain.removeHandler('worktrees:prefetchCreateBase')
  ipcMain.removeHandler('worktrees:resolvePrBase')
  ipcMain.removeHandler('worktrees:resolveMrBase')
  ipcMain.removeHandler('worktrees:remove')
  ipcMain.removeHandler('worktrees:forceDeletePreservedBranch')
  ipcMain.removeHandler('worktrees:updateMeta')
  ipcMain.removeHandler('worktrees:listLineage')
  ipcMain.removeHandler('worktrees:updateLineage')
  ipcMain.removeHandler('worktrees:persistSortOrder')
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

    // Why: each local repo listing can spawn `git worktree list`; cap fan-out
    // so large repo fleets don't start unbounded subprocesses at once.
    const results = await mapWithConcurrency(repos, WORKTREE_LIST_ALL_CONCURRENCY, async (repo) => {
      try {
        let gitWorktrees
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
            return listDisconnectedSshWorktrees(store, repos, repo, sshWorktreeMetaIndex)
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
            return listDisconnectedSshWorktrees(store, repos, repo, sshWorktreeMetaIndex)
          }
        } else {
          gitWorktrees = await listRepoWorktrees(
            repo,
            getLocalProjectWorktreeGitOptions(store, repo)
          )
        }
        rememberLocalWorktreeRoots(store, repo, gitWorktrees)
        pruneLineageForMissingRepoWorktrees(store, repo, gitWorktrees)
        loggedWorktreeListFailures.delete(`${repo.id}:${repo.path}`)
        return buildDetectedGitWorktrees(store, repos, repo, gitWorktrees)
          .filter((worktree) => worktree.visible)
          .map((worktree) => stampAndMergeVisibleDetectedWorktree(store, repos, repo, worktree))
      } catch (err) {
        warnOnce(
          loggedWorktreeListFailures,
          `${repo.id}:${repo.path}`,
          `[worktrees] failed to list worktrees for repo "${repo.displayName}" (${repo.id}) at ${repo.path}`,
          err
        )
        // Why: do NOT seed an empty success here. registerWorktreeRootsForRepo
        // would mark this repo as registered and flip
        // registeredWorktreeRootsDirty to false, which causes
        // resolveRegisteredWorktreePath to permanently deny access to
        // legitimate linked worktrees of this repo until something invalidates
        // the cache. Leaving it unregistered keeps the cache dirty so the
        // next access path can rebuild.
        return []
      }
    })

    return results.flat()
  })

  ipcMain.handle('worktrees:list', async (_event, args: { repoId: string; hostId?: string }) => {
    const hostId = args.hostId ? normalizeExecutionHostId(args.hostId) : undefined
    if (args.hostId && !hostId) {
      throw new Error(`Invalid execution host id: ${args.hostId}`)
    }
    const repo = getRepoForHostScopedRequest(store, {
      repoId: args.repoId,
      ...(hostId ? { hostId } : {})
    })
    if (!repo) {
      return []
    }
    const repos = store.getRepos()
    const sshWorktreeMetaIndex = repo.connectionId
      ? createSshWorktreeMetaIndex(Object.entries(store.getAllWorktreeMeta()))
      : new Map()

    try {
      let gitWorktrees
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
          return listDisconnectedSshWorktrees(store, repos, repo, sshWorktreeMetaIndex)
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
          return listDisconnectedSshWorktrees(store, repos, repo, sshWorktreeMetaIndex)
        }
      } else {
        gitWorktrees = await listRepoWorktrees(repo, getLocalProjectWorktreeGitOptions(store, repo))
      }
      rememberLocalWorktreeRoots(store, repo, gitWorktrees)
      pruneLineageForMissingRepoWorktrees(store, repo, gitWorktrees)
      loggedWorktreeListFailures.delete(`${repo.id}:${repo.path}`)
      return buildDetectedGitWorktrees(store, repos, repo, gitWorktrees)
        .filter((worktree) => worktree.visible)
        .map((worktree) => stampAndMergeVisibleDetectedWorktree(store, repos, repo, worktree))
    } catch (err) {
      warnOnce(
        loggedWorktreeListFailures,
        `${repo.id}:${repo.path}`,
        `[worktrees] failed to list worktrees for repo "${repo.displayName}" (${repo.id}) at ${repo.path}`,
        err
      )
      // Why: see worktrees:listAll catch — seeding an empty-success result
      // would poison the auth cache and block linked worktrees.
      return []
    }
  })

  ipcMain.handle(
    'worktrees:listDetected',
    async (
      _event,
      args: { repoId: string; hostId?: string }
    ): Promise<DetectedWorktreeListResult> => {
      const hostId = args.hostId ? normalizeExecutionHostId(args.hostId) : undefined
      if (args.hostId && !hostId) {
        throw new Error(`Invalid execution host id: ${args.hostId}`)
      }
      const repo = getRepoForHostScopedRequest(store, {
        repoId: args.repoId,
        ...(hostId ? { hostId } : {})
      })
      if (!repo) {
        return {
          repoId: args.repoId,
          authoritative: false,
          source: 'metadata-fallback',
          worktrees: []
        }
      }
      const repos = store.getRepos()
      const sshWorktreeMetaIndex = repo.connectionId
        ? createSshWorktreeMetaIndex(Object.entries(store.getAllWorktreeMeta()))
        : new Map()

      try {
        let gitWorktrees: GitWorktreeInfo[]
        let freshScan = true
        if (isFolderRepo(repo)) {
          return {
            repoId: repo.id,
            authoritative: true,
            source: 'git',
            worktrees: buildFolderDetectedWorktrees(store, repo)
          }
        } else if (repo.connectionId) {
          const provider = getSshGitProvider(repo.connectionId)
          if (!provider) {
            const worktrees = listDisconnectedSshWorktrees(store, repos, repo, sshWorktreeMetaIndex)
            return {
              repoId: repo.id,
              authoritative: false,
              source: 'metadata-fallback',
              worktrees: buildDisconnectedDetectedWorktrees(store, repo, worktrees)
            }
          }
          gitWorktrees = await provider.listWorktrees(repo.path)
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
        return {
          repoId: repo.id,
          authoritative: true,
          source: 'git',
          worktrees: buildDetectedGitWorktrees(store, repos, repo, gitWorktrees)
        }
      } catch (err) {
        warnOnce(
          loggedWorktreeListFailures,
          `${repo.id}:${repo.path}`,
          `[worktrees] failed to list detected worktrees for repo "${repo.displayName}" (${repo.id}) at ${repo.path}`,
          err
        )
        if (repo.connectionId) {
          const worktrees = listDisconnectedSshWorktrees(store, repos, repo, sshWorktreeMetaIndex)
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
        // Why: this is an optimistic warm-up. The actual create path still
        // awaits the same refresh and reports user-visible failures there.
      }
    }
  )

  ipcMain.handle(
    'worktrees:create',
    async (_event, args: CreateWorktreeArgs): Promise<CreateWorktreeResult> => {
      // Why span here: worktree creation chains a clone-or-checkout, an
      // install hook, and several git invocations. Wrapping the IPC entry
      // gives every child git span a parent to attach to, so a failure in
      // step 3 of 5 still shows up in the trace tree alongside steps 1–2.
      // The branch name and remote URL are intentionally not added as
      // attributes — branch names can carry user-content (e.g. an issue
      // title) and the redactor would have to learn yet another rule;
      // the repo ID is the safer correlator for the bundle.
      return withWorktreeSpan({ stage: 'create' }, async () => {
        const requestedHostId = args.hostId ? normalizeExecutionHostId(args.hostId) : null
        if (args.hostId && !requestedHostId) {
          throw new Error(`Invalid execution host id: ${args.hostId}`)
        }
        const repo = requestedHostId
          ? store
              .getRepos()
              .find(
                (candidate) =>
                  candidate.id === args.repoId &&
                  getRepoExecutionHostId(candidate) === requestedHostId
              )
          : store.getRepo(args.repoId)
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
          // Why: only wrap the helpers themselves. The pre-validation throws
          // above (`Repo not found`, `Folder mode does not support creating
          // worktrees`) signal IPC-shape bugs, not the user-visible
          // git/filesystem failures the funnel cares about — bucketing them
          // into `unknown` would pollute the failure taxonomy.
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

        // Why: emit `workspace_created` only after the underlying create has
        // resolved (the helpers throw on failure, so reaching this line means
        // git-add succeeded — we deliberately do not also emit a separate
        // `workspace_initialized`, see telemetry-plan.md§Deferred events).
        // `from_existing_branch` is true iff the caller specified a non-empty
        // baseBranch; an unspecified baseBranch means "branch from default
        // HEAD", which is the not-from-existing-branch case. We never send
        // the branch name itself.
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
      // Why: SSH repos can't fetch over the relay's read-only git.exec channel, so
      // route the PR head fetch through the write-capable helper instead of gitExec.
      const fetchRemoteTrackingRef = (remote: string, branch: string): Promise<void> =>
        fetchPrHeadTrackingRef(
          repo,
          repo.connectionId ? getSshGitProvider(repo.connectionId) : undefined,
          remote,
          branch,
          { localGitExecOptions: getLocalProjectGitExecOptions(store, repo) }
        )

      return resolveGitHubPrStartPoint({
        repoPath: repo.path,
        prNumber: args.prNumber,
        headRefName: args.headRefName,
        baseRefName: args.baseRefName,
        isCrossRepository: args.isCrossRepository,
        connectionId: repo.connectionId ?? null,
        localGitOptions: getLocalProjectWorktreeGitOptions(store, repo),
        gitExec,
        fetchRemoteTrackingRef,
        resolveRemote: async () => {
          if (repo.connectionId) {
            const { stdout } = await gitExec(['remote'])
            return (
              stdout
                .split('\n')
                .map((line) => line.trim())
                .find(Boolean) ?? 'origin'
            )
          }
          return getDefaultRemote(repo.path, getLocalProjectWorktreeGitOptions(store, repo))
        }
      })
    }
  )

  // Why: keep desktop IPC and mobile/runtime RPC on the same MR base
  // resolution path so SSH repos do not regress differently by surface.
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
    async (_event, args: { worktreeId: string; force?: boolean; skipArchive?: boolean }) => {
      const optionsKey = getWorktreeRemovalOptionsKey(args)
      const inFlightRemoval = worktreeRemovalsInFlight.get(args.worktreeId)
      if (inFlightRemoval) {
        if (inFlightRemoval.optionsKey === optionsKey) {
          return inFlightRemoval.promise
        }
        throw new Error(`Worktree deletion already in progress: ${args.worktreeId}`)
      }

      // Why: stale toast actions, double-clicks, and Space/sidebar races can
      // target the same worktree concurrently. Share the destructive backend
      // operation so only one path touches Git and the filesystem.
      const removal = (async (): Promise<RemoveWorktreeResult> => {
        const parsedWorktreeId = parseWorktreeId(args.worktreeId) as ReturnType<
          typeof parseWorktreeId
        > & { hostId?: string }
        const { repoId, worktreePath } = parsedWorktreeId
        const repo = getRepoForWorktreeRemoval(store, parsedWorktreeId)
        if (!repo) {
          throw new Error(`Repo not found: ${repoId}`)
        }
        const removalWorktreeIds = getWorktreeRemovalIdAliases(
          store,
          store.getRepos(),
          repo,
          worktreePath,
          args.worktreeId
        )
        const clearRemovalState = (options: { clearPreservedBranch?: boolean } = {}) => {
          for (const worktreeId of removalWorktreeIds) {
            runtime.clearOptimisticReconcileToken(worktreeId)
            if (options.clearPreservedBranch) {
              preservedBranchCleanupByWorktreeId.delete(worktreeId)
            }
          }
          removeWorktreeAliasesMetadataAndTransientState(store, removalWorktreeIds)
        }
        if (isFolderRepo(repo)) {
          if (isFolderWorkspaceRootIdForRepo(repo, args.worktreeId)) {
            throw new Error(
              'Cannot delete the project root workspace. Remove the folder project instead.'
            )
          }
          // Why: folder workspaces share one filesystem root, so there is no Git
          // remove step to close shells; sweep PTYs before dropping metadata.
          await killAllProcessesForWorktree(args.worktreeId, {
            runtime,
            localProvider: getLocalPtyProvider(),
            onPtyStopped: clearProviderPtyState
          }).catch((err) => {
            console.warn(`[worktree-teardown] failed for ${args.worktreeId}:`, err)
          })
          clearRemovalState({ clearPreservedBranch: true })
          notifyWorktreesChanged(mainWindow, repoId)
          return {}
        }

        // Why: the renderer-supplied worktreeId contains a filesystem path.
        // Re-derive the canonical path from git before any destructive action.
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
        const removedMeta = getRemovalWorktreeMeta(store, removalWorktreeIds)
        const removedPushTarget = removedMeta?.pushTarget
        const registeredWorktree = findRegisteredDeletableWorktree(
          repo.path,
          worktreePath,
          registeredWorktrees
        )
        if (!registeredWorktree) {
          const fsProvider = repo.connectionId ? getSshFilesystemProvider(repo.connectionId) : null
          let canCleanOrphanedDirectory = false
          const knownOrcaLayouts = buildKnownOrcaWorkspaceLayouts(store.getSettings(), repo)
          if (
            canCleanupUnregisteredOrcaWorktreeDirectory({
              meta: removedMeta,
              worktreePath,
              repo,
              knownOrcaLayouts
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
              canCleanOrphanedDirectory = await canSafelyRemoveOrphanedWorktreeDirectory(
                toLocalWorktreeRuntimePath(worktreePath, localWorktreeGitOptions),
                toLocalWorktreeRuntimePath(repo.path, localWorktreeGitOptions),
                access.statPath,
                access.readPath
              )
            }
          }
          if (canCleanOrphanedDirectory) {
            assertWorktreeDoesNotContainRegisteredWorktree(
              toLocalWorktreeRuntimePath(worktreePath, localWorktreeGitOptions),
              registeredWorktrees
            )
            if (!args.force) {
              throw new Error(ORPHANED_WORKTREE_DIRECTORY_MESSAGE)
            }
            if (repo.connectionId) {
              await fsProvider!.deletePath(worktreePath, true)
              await cleanupUnusedWorktreePushTargetRemoteSsh(
                provider!,
                repo.path,
                removalWorktreeIds,
                removedPushTarget,
                store
              )
            } else {
              await closeLocalWatcherForRemoval(worktreePath)
              await removeLocalWorktreePath(worktreePath, localWorktreeGitOptions)
              await cleanupUnusedWorktreePushTargetRemote(
                repo.path,
                removalWorktreeIds,
                removedPushTarget,
                store,
                localWorktreeGitOptions
              )
              invalidateAuthorizedRootsCache()
            }
            clearRemovalState({ clearPreservedBranch: true })
            notifyWorktreesChanged(mainWindow, repoId)
            return {}
          }
          if (await isAlreadyRemovedWorktreePath(repo, worktreePath, localWorktreeGitOptions)) {
            if (!args.force && !removedMeta) {
              // Why: without persisted metadata, require the renderer recovery
              // path before deleting Orca-only state for an unregistered path.
              throw new Error(UNREGISTERED_MISSING_WORKTREE_MESSAGE)
            }
            // Why: a manually deleted worktree is already gone from Git and disk.
            // The sidebar delete action has persisted metadata proving this was
            // an Orca-known row, so no force confirmation is needed.
            if (repo.connectionId) {
              await cleanupUnusedWorktreePushTargetRemoteSsh(
                provider!,
                repo.path,
                removalWorktreeIds,
                removedPushTarget,
                store
              )
            } else {
              await cleanupUnusedWorktreePushTargetRemote(
                repo.path,
                removalWorktreeIds,
                removedPushTarget,
                store,
                localWorktreeGitOptions
              )
              invalidateAuthorizedRootsCache()
            }
            clearRemovalState({ clearPreservedBranch: true })
            notifyWorktreesChanged(mainWindow, repoId)
            return {}
          }
          throw new Error(`Refusing to delete unregistered worktree path: ${worktreePath}`)
        }
        const canonicalWorktreePath = registeredWorktree.path
        const deleteBranch = removedMeta?.preserveBranchOnDelete !== true

        let shouldTearDownPtys = true

        // Run archive hook before removal so teardown scripts still see the worktree directory.
        const hooks = await getArchiveHooksForRemoval(repo)
        if (hooks?.scripts.archive && !args.skipArchive) {
          const result = repo.connectionId
            ? await runRemoteArchiveHook(repo, canonicalWorktreePath, hooks.scripts.archive)
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

        if (repo.connectionId) {
          // Why: SSH deletion mirrors the local flow: hooks run while the
          // directory is intact, then the clean check guards destructive removal.
          if (!args.force) {
            const { clean, stdout } = await provider!.worktreeIsClean(canonicalWorktreePath)
            if (!clean) {
              const error = new Error('Worktree has uncommitted or untracked changes.')
              ;(error as Error & { stdout?: string }).stdout = stdout
              throw error
            }
          }

          const rawRemovalResult = await (deleteBranch
            ? provider!.removeWorktree(canonicalWorktreePath, args.force)
            : provider!.removeWorktree(canonicalWorktreePath, args.force, { deleteBranch }))
          const removalResult = preserveBranchHeadFallback(
            rawRemovalResult,
            registeredWorktree.head
          )
          await cleanupUnusedWorktreePushTargetRemoteSsh(
            provider!,
            repo.path,
            removalWorktreeIds,
            removedPushTarget,
            store
          )
          rememberPreservedBranchCleanupTarget(
            removalWorktreeIds,
            removalResult,
            registeredWorktree.head,
            removedPushTarget
          )
          clearRemovalState()
          notifyWorktreesChanged(mainWindow, repoId)
          return removalResult ?? {}
        }

        // Why: `git worktree remove` (non-force) refuses to delete a worktree
        // that has untracked files. User-configured symlinks look untracked,
        // so unlink them before the clean check; regular APFS clone-copied
        // files are left for git to judge so we never delete user edits.
        if (repo.symlinkPaths && repo.symlinkPaths.length > 0) {
          await removeWorktreeLinkedPaths(canonicalWorktreePath, repo.symlinkPaths)
        }

        try {
          await (hasLocalWorktreeGitOptions
            ? assertWorktreeCleanForRemoval(
                canonicalWorktreePath,
                args.force ?? false,
                localWorktreeGitOptions
              )
            : assertWorktreeCleanForRemoval(canonicalWorktreePath, args.force ?? false))
        } catch (error) {
          if (!isOrphanCompatiblePreflightError(error)) {
            throw new Error(
              formatWorktreeRemovalError(error, canonicalWorktreePath, args.force ?? false)
            )
          }
          // Why: orphan cleanup does not need live shells to be killed first,
          // and preflight did not prove the worktree is cleanly removable.
          shouldTearDownPtys = false
        }

        await closeLocalWatcherForRemoval(canonicalWorktreePath)

        if (shouldTearDownPtys) {
          // Why: once preflight proves normal deletion is clean, kill PTYs before
          // git-level removal so Windows handles cannot keep the directory busy.
          await killAllProcessesForWorktree(args.worktreeId, {
            runtime,
            localProvider: getLocalPtyProvider(),
            onPtyStopped: clearProviderPtyState
          })
            .then((r) => {
              const total = r.runtimeStopped + r.providerStopped + r.registryStopped
              if (total > 0) {
                console.info(
                  `[worktree-teardown] ${args.worktreeId} killed runtime=${r.runtimeStopped} provider=${r.providerStopped} registry=${r.registryStopped}`
                )
              }
            })
            .catch((err) => {
              console.warn(`[worktree-teardown] failed for ${args.worktreeId}:`, err)
            })
        }

        let removalResult: RemoveWorktreeResult | undefined
        try {
          const removeOptions = {
            ...(!deleteBranch ? { deleteBranch } : {}),
            // Why: this handler already paid for an authoritative worktree
            // list to validate the target; reuse it instead of rescanning
            // every sibling worktree during the hot delete path.
            knownRemovedWorktree: registeredWorktree,
            ...(hasLocalWorktreeGitOptions ? localWorktreeGitOptions : {})
          }
          removalResult = preserveBranchHeadFallback(
            await removeWorktree(
              repo.path,
              canonicalWorktreePath,
              args.force ?? false,
              removeOptions
            ),
            registeredWorktree.head
          )
        } catch (error) {
          // If git no longer tracks this worktree, clean up the directory and metadata
          if (isOrphanedWorktreeError(error)) {
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
              await closeLocalWatcherForRemoval(canonicalWorktreePath)
              await removeLocalWorktreePath(canonicalWorktreePath, localWorktreeGitOptions).catch(
                () => {}
              )
            } else {
              console.warn(
                `[worktrees] Refusing recursive cleanup for unproven worktree directory: ${canonicalWorktreePath}`
              )
            }
            // Why: `git worktree remove` failed, so git's internal worktree tracking
            // (`.git/worktrees/<name>`) is still intact. Without pruning, `git worktree
            // list` continues to show the stale entry and the branch it had checked out
            // remains locked — other worktrees cannot check it out.
            await gitExecFileAsync(['worktree', 'prune'], {
              cwd: repo.path,
              ...localWorktreeGitOptions
            }).catch(() => {})
            await cleanupUnusedWorktreePushTargetRemote(
              repo.path,
              removalWorktreeIds,
              removedPushTarget,
              store,
              localWorktreeGitOptions
            )
            clearRemovalState({ clearPreservedBranch: true })
            invalidateAuthorizedRootsCache()
            notifyWorktreesChanged(mainWindow, repoId)
            return {}
          }
          throw new Error(
            formatWorktreeRemovalError(error, canonicalWorktreePath, args.force ?? false)
          )
        }
        await cleanupUnusedWorktreePushTargetRemote(
          repo.path,
          removalWorktreeIds,
          removedPushTarget,
          store,
          localWorktreeGitOptions
        )
        rememberPreservedBranchCleanupTarget(
          removalWorktreeIds,
          removalResult,
          registeredWorktree.head,
          removedPushTarget
        )
        clearRemovalState()
        invalidateAuthorizedRootsCache()

        notifyWorktreesChanged(mainWindow, repoId)
        return removalResult ?? {}
      })()
      worktreeRemovalsInFlight.set(args.worktreeId, { optionsKey, promise: removal })
      try {
        return await removal
      } finally {
        if (worktreeRemovalsInFlight.get(args.worktreeId)?.promise === removal) {
          worktreeRemovalsInFlight.delete(args.worktreeId)
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
      const parsedWorktreeId = parseWorktreeId(args.worktreeId) as ReturnType<
        typeof parseWorktreeId
      > & { hostId?: string }
      const { repoId } = parsedWorktreeId
      const cleanupTarget = getPreservedBranchCleanupTarget(
        args.worktreeId,
        args.branchName,
        args.expectedHead
      )
      const repo = getRepoForWorktreeRemoval(store, parsedWorktreeId)
      if (!repo) {
        throw new Error(`Repo not found: ${repoId}`)
      }
      const cleanupWorktreeIds = getWorktreeRemovalIdAliases(
        store,
        store.getRepos(),
        repo,
        parsedWorktreeId.worktreePath,
        args.worktreeId
      )
      if (isFolderRepo(repo)) {
        throw new Error('Folder workspaces do not have local Git branches.')
      }

      if (repo.connectionId) {
        const provider = requireSshGitProvider(repo.connectionId)
        await forceDeleteLocalBranch(
          repo.path,
          cleanupTarget.branchName,
          cleanupTarget.head,
          (argv, cwd) => provider.exec(argv, cwd)
        )
        await cleanupUnusedWorktreePushTargetRemoteSsh(
          provider,
          repo.path,
          cleanupWorktreeIds,
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
          cleanupWorktreeIds,
          cleanupTarget.pushTarget,
          store,
          localWorktreeGitOptions
        )
      }

      for (const worktreeId of cleanupWorktreeIds) {
        preservedBranchCleanupByWorktreeId.delete(worktreeId)
      }
      return { deleted: true }
    }
  )

  ipcMain.handle(
    'worktrees:updateMeta',
    (_event, args: { worktreeId: string; updates: Partial<WorktreeMeta> }) => {
      const updates =
        args.updates.displayName !== undefined
          ? {
              ...args.updates,
              pendingFirstAgentMessageRename: false,
              firstAgentMessageRenameError: null
            }
          : args.updates
      const meta = store.setWorktreeMeta(args.worktreeId, stripOrcaProvenanceMetaUpdates(updates))
      // Do NOT call notifyWorktreesChanged here. The renderer applies meta
      // updates optimistically before calling this IPC, so a notification
      // would trigger a redundant fetchWorktrees round-trip that bumps
      // sortEpoch and reorders the sidebar — the exact bug PR #209 tried
      // to fix (clicking a card would clear isUnread → updateMeta →
      // worktrees:changed → fetchWorktrees → sortEpoch++ → re-sort).
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

  // Why: the renderer continuously snapshots the computed sidebar order into
  // sortOrder so that it can be restored on cold start (when ephemeral signals
  // like running jobs and live terminals are gone). A single batch call avoids
  // N individual updateMeta IPC round-trips; the persistence layer debounces
  // the actual disk write.
  ipcMain.handle('worktrees:persistSortOrder', (_event, args: { orderedIds: string[] }) => {
    // Defensive: guard against malformed or missing input from the renderer.
    if (!Array.isArray(args?.orderedIds) || args.orderedIds.length === 0) {
      return
    }
    const now = Date.now()
    for (let i = 0; i < args.orderedIds.length; i++) {
      // Descending timestamps so that the first item has the highest
      // sortOrder value (most recent), making b.sortOrder - a.sortOrder
      // a natural "first wins" comparator on cold start.
      store.setWorktreeMeta(args.orderedIds[i], { sortOrder: now - i * 1000 })
    }
  })

  ipcMain.handle('hooks:check', async (_event, args: { repoId: string }) => {
    const repo = store.getRepo(args.repoId)
    if (!repo || isFolderRepo(repo)) {
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
    // Why: when a newer Orca version adds a top-level key to `orca.yaml`, older
    // versions that don't recognise it return null and show "could not be parsed".
    // Detecting well-formed but unrecognised keys lets the UI suggest updating
    // instead of implying the file is broken.
    const mayNeedUpdate = has && !hooks && hasUnrecognizedOrcaYamlKeys(repo.path)
    return {
      status: 'ok',
      hasHooks: has,
      hooks,
      mayNeedUpdate
    }
  })

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
        getLocalProjectWorktreeGitOptions(store, repo)
      )
    }
  )

  ipcMain.handle('hooks:inspectSetupScriptImports', async (_event, args: { repoId: string }) => {
    const repo = store.getRepo(args.repoId)
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
  })

  ipcMain.handle('hooks:readIssueCommand', async (_event, args: { repoId: string }) => {
    const repo = store.getRepo(args.repoId)
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
  })

  ipcMain.handle(
    'hooks:writeIssueCommand',
    async (_event, args: { repoId: string; content: string }) => {
      const repo = store.getRepo(args.repoId)
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
