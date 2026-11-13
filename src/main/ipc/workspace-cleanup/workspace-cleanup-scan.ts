import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import { isFolderRepo } from '../../../shared/repo-kind'
import type { PRInfo } from '../../../shared/github/pull-requests/pull-request-types'
import type { PRCacheView } from '../../../shared/sidebar-list/workspace-review-facts'
import { readWorktreeMetaForHost } from '../../persistence/host-qualified-worktree-meta'
import type { Repo } from '../../../shared/repo-types'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import { mergeWorktree } from '../worktree-metadata-merge'
import type {
  WorkspaceCleanupAutomationRunLookup,
  WorkspaceCleanupCandidate,
  WorkspaceCleanupScanArgs,
  WorkspaceCleanupScanError,
  WorkspaceCleanupScanResult
} from '../../../shared/workspace-cleanup/workspace-cleanup'
import {
  handleRepoWorktreeListError,
  listCleanupGitWorktrees
} from './workspace-cleanup-worktree-listing'
import type { WorkspaceCleanupGitRoute } from './workspace-cleanup-git-route'
import { shouldScanBroadWorkspaceCleanupWorktree } from './workspace-cleanup-scan-eligibility'
import {
  resolvePersistedWorkspaceCleanupActivityWorktree,
  resolveWorkspaceCleanupActivityWithTimeout,
  type WorkspaceCleanupFsActivityCache
} from './workspace-cleanup-activity'
import {
  buildWorkspaceCleanupCandidate,
  buildWorkspaceCleanupCandidateFromError,
  createWorkspaceCleanupAutomationRunLookup,
  isWorkspaceInactiveForCleanup
} from './workspace-cleanup-candidate'
import { synthesizeDisconnectedSshCleanupCandidates } from './workspace-cleanup-disconnected-ssh'
import {
  WorkspaceCleanupScanCancelledError,
  appendWorkspaceCleanupItems,
  mapWorkspaceCleanupWithConcurrency,
  throwIfWorkspaceCleanupScanAborted
} from './workspace-cleanup-scan-primitives'
import { listWorkspaceCleanupFolderWorkspaces } from './workspace-cleanup-folder-workspaces'
import { createWorkspaceCleanupRepoRefs } from './workspace-cleanup-merge-evidence'
import {
  createWorkspaceCleanupProgressEmitter,
  type WorkspaceCleanupScanOptions
} from './workspace-cleanup-progress-emitter'
import {
  getTargetWorktreeIdsByRepo,
  hasTargetedWorkspaceCleanupScan
} from './workspace-cleanup-scan-targets'
import { isWorktreeMetaOwnedByRepo } from '../../workspaces/catalog/worktree-metadata-ownership'
import { runtimeVisibleRepos } from '../../runtime/workspaces/catalog/runtime-visible-catalog'
import {
  createWorkspaceCleanupReleasedWorkerLookup,
  type WorkspaceCleanupReleasedWorkerLookup
} from './workspace-cleanup-orchestration-workers'

const WORKTREE_SCAN_CONCURRENCY = 3
// Overlap repo scans to avoid summing SSH listing round-trip latency.
const REPO_SCAN_CONCURRENCY = 2

type WorkspaceCleanupScanRepoProgress = {
  onWorktreesDiscovered?: (count: number) => void
  onCandidateScanned?: (candidate: WorkspaceCleanupCandidate) => void
  onErrors?: (errors: WorkspaceCleanupScanError[]) => void
}

export async function scanWorkspaceCleanup(
  store: RuntimeStore,
  args: WorkspaceCleanupScanArgs = {},
  options: WorkspaceCleanupScanOptions = {}
): Promise<WorkspaceCleanupScanResult> {
  throwIfWorkspaceCleanupScanAborted(options.signal)
  const scannedAt = Date.now()
  const targetWorktreeIdsByRepo = getTargetWorktreeIdsByRepo(args)
  if (hasTargetedWorkspaceCleanupScan(args) && targetWorktreeIdsByRepo.size === 0) {
    return { scannedAt, candidates: [], errors: [] }
  }
  const allRepos = store.getRepos()
  // Hidden source rows (an SSH host now served by its own orcad) are that server's to scan.
  const visibleRepos = runtimeVisibleRepos(store)
  const repos =
    targetWorktreeIdsByRepo.size > 0
      ? visibleRepos.filter((repo) => targetWorktreeIdsByRepo.has(repo.id))
      : visibleRepos
  const repoOwnerCountById = new Map<string, number>()
  for (const repo of allRepos) {
    repoOwnerCountById.set(repo.id, (repoOwnerCountById.get(repo.id) ?? 0) + 1)
  }
  // One snapshot per scan: merged-review evidence reads it without the network.
  const prCache = store.getGitHubCache().pr
  const findAutomationRun = createWorkspaceCleanupAutomationRunLookup(store)
  const findReleasedWorker = createWorkspaceCleanupReleasedWorkerLookup(
    store,
    options.getOrchestrationDb
  )
  const progress = createWorkspaceCleanupProgressEmitter(args.scanId, scannedAt, options)
  const errors: WorkspaceCleanupScanResult['errors'] = []
  const candidates: WorkspaceCleanupCandidate[] = []

  try {
    const repoResults = await mapWorkspaceCleanupWithConcurrency(
      repos,
      REPO_SCAN_CONCURRENCY,
      async (repo) => {
        throwIfWorkspaceCleanupScanAborted(options.signal)
        return scanRepoWorkspaces({
          store,
          repo,
          repoOwnerCount: repoOwnerCountById.get(repo.id) ?? 1,
          scannedAt,
          prCache,
          findAutomationRun,
          findReleasedWorker,
          targetWorktreeIds: targetWorktreeIdsByRepo.get(repo.id),
          refreshTargetActivity: args.worktreeId !== undefined || args.refreshActivity === true,
          includeAllWorkspaces: args.includeAllWorkspaces === true,
          skipGitWorktreeIds: new Set(args.skipGitWorktreeIds ?? []),
          signal: options.signal,
          onWorktreesDiscovered: progress.addDiscovered,
          onCandidateScanned: progress.addCandidate,
          onErrors: progress.addErrors
        })
      }
    )
    for (const result of repoResults) {
      appendWorkspaceCleanupItems(candidates, result.candidates)
      appendWorkspaceCleanupItems(errors, result.errors)
    }
    return { scannedAt, candidates, errors }
  } finally {
    progress.flush()
  }
}

async function scanRepoWorkspaces(
  args: {
    store: RuntimeStore
    repo: Repo
    repoOwnerCount: number
    scannedAt: number
    prCache: PRCacheView<PRInfo>
    findAutomationRun: WorkspaceCleanupAutomationRunLookup
    findReleasedWorker: WorkspaceCleanupReleasedWorkerLookup
    targetWorktreeIds?: ReadonlySet<string>
    refreshTargetActivity: boolean
    includeAllWorkspaces: boolean
    skipGitWorktreeIds: Set<string>
    signal?: AbortSignal
  } & WorkspaceCleanupScanRepoProgress
): Promise<WorkspaceCleanupScanResult> {
  const {
    store,
    repo,
    repoOwnerCount,
    scannedAt,
    prCache,
    findAutomationRun,
    findReleasedWorker,
    targetWorktreeIds,
    refreshTargetActivity,
    includeAllWorkspaces,
    skipGitWorktreeIds,
    signal,
    onWorktreesDiscovered,
    onCandidateScanned,
    onErrors
  } = args
  const errors: WorkspaceCleanupScanResult['errors'] = []
  const repoIsFolder = isFolderRepo(repo)
  let route: WorkspaceCleanupGitRoute
  let gitWorktrees: GitWorktreeInfo[] = []

  try {
    const discovered = await listCleanupGitWorktrees(store, repo, repoIsFolder, signal)
    route = discovered.route
    gitWorktrees = discovered.gitWorktrees
  } catch (error) {
    if (error instanceof WorkspaceCleanupScanCancelledError) {
      throw error
    }
    return handleRepoWorktreeListError({
      repo,
      targeted: targetWorktreeIds !== undefined,
      scannedAt,
      error,
      onErrors
    })
  }

  if (route.kind === 'ssh') {
    // Full lists retain unreachable workspaces as blocked; legacy scans omit uninspectable hosts.
    const candidates =
      targetWorktreeIds || includeAllWorkspaces
        ? synthesizeDisconnectedSshCleanupCandidates(
            store,
            repo,
            scannedAt,
            repoOwnerCount,
            targetWorktreeIds,
            includeAllWorkspaces
          )
        : []
    onWorktreesDiscovered?.(candidates.length)
    for (const candidate of candidates) {
      onCandidateScanned?.(candidate)
    }
    return { scannedAt, candidates, errors: [] }
  }

  const mergedWorktrees =
    repoIsFolder && includeAllWorkspaces
      ? listWorkspaceCleanupFolderWorkspaces(store, repo, repoOwnerCount)
      : gitWorktrees.map((gitWorktree) => {
          const worktreeId = `${repo.id}::${gitWorktree.path}`
          // Host-qualified first: the same repoId::path is a different checkout on each host.
          const hostMeta = readWorktreeMetaForHost(store, worktreeId, route.hostId)
          const meta = store.getWorktreeMeta(worktreeId)
          const ownedMeta =
            hostMeta ?? (isWorktreeMetaOwnedByRepo(repo, meta, repoOwnerCount) ? meta : undefined)
          return mergeWorktree(repo.id, gitWorktree, ownedMeta, repo.displayName)
        })
  // Full-list views filter client-side; age thresholds here would hide workspaces from every view.
  const candidateWorktrees = targetWorktreeIds
    ? mergedWorktrees.filter((worktree) => targetWorktreeIds.has(worktree.id))
    : mergedWorktrees.filter((worktree) =>
        shouldScanBroadWorkspaceCleanupWorktree({
          includeAllWorkspaces,
          repoIsFolder,
          worktree,
          scannedAt
        })
      )
  // Discover all targeted/full-list rows upfront so progress does not stay near 100%.
  const reportDiscoveredUpfront = targetWorktreeIds !== undefined || includeAllWorkspaces
  if (reportDiscoveredUpfront && candidateWorktrees.length > 0) {
    onWorktreesDiscovered?.(candidateWorktrees.length)
  }
  // Stat cannot cancel: after one timeout, use persisted activity rather than queueing more work on a hung mount.
  let activityStatsUnavailable = false
  const fsActivityCache: WorkspaceCleanupFsActivityCache = new Map()
  const repoRefs = createWorkspaceCleanupRepoRefs(repo, signal)
  const candidatesWithSkipped = await mapWorkspaceCleanupWithConcurrency(
    candidateWorktrees,
    WORKTREE_SCAN_CONCURRENCY,
    async (worktree) => {
      throwIfWorkspaceCleanupScanAborted(signal)
      // Filesystem activity protects external worktrees missing Orca stamps from deletion suggestions.
      const persistedActivityWorktree = resolvePersistedWorkspaceCleanupActivityWorktree(worktree)
      const persistedActivityIsRecent = !isWorkspaceInactiveForCleanup(
        persistedActivityWorktree,
        scannedAt
      )
      const worktreeWithActivity =
        activityStatsUnavailable ||
        (targetWorktreeIds ? !refreshTargetActivity : persistedActivityIsRecent)
          ? persistedActivityWorktree
          : await resolveWorkspaceCleanupActivityWithTimeout(
              route,
              worktree,
              () => {
                activityStatsUnavailable = true
              },
              signal,
              fsActivityCache
            )
      const isInactive = isWorkspaceInactiveForCleanup(worktreeWithActivity, scannedAt)
      if (!targetWorktreeIds && !includeAllWorkspaces && !isInactive) {
        return null
      }
      if (!reportDiscoveredUpfront) {
        onWorktreesDiscovered?.(1)
      }
      const candidate = await buildWorkspaceCleanupCandidate({
        repo,
        worktree: worktreeWithActivity,
        scannedAt,
        route,
        prCache,
        // Defer Git for active rows during fleet scans; forced removal preflight reads fresh evidence.
        skipGit: skipGitWorktreeIds.has(worktreeWithActivity.id) || !isInactive,
        forceGitCheck: Boolean(targetWorktreeIds),
        findAutomationRun,
        releasedWorker: findReleasedWorker(worktreeWithActivity, mergedWorktrees),
        signal,
        repoRefs
      }).catch((error) => {
        if (error instanceof WorkspaceCleanupScanCancelledError) {
          throw error
        }
        console.error('Workspace cleanup candidate scan failed', error)
        return buildWorkspaceCleanupCandidateFromError(repo, worktreeWithActivity, scannedAt)
      })
      onCandidateScanned?.(candidate)
      return candidate
    }
  )
  const candidates = candidatesWithSkipped.filter(
    (candidate): candidate is WorkspaceCleanupCandidate => candidate !== null
  )

  return { scannedAt, candidates, errors }
}
