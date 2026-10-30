import type { Store } from '../persistence'
import { isFolderRepo } from '../../shared/repo-kind'
import { readWorktreeMetaForHost } from '../persistence/host-qualified-worktree-meta'
import type { Repo } from '../../shared/repo-types'
import type { GitWorktreeInfo, Worktree } from '../../shared/worktree/types'
import { mergeWorktree } from './worktree-metadata-merge'
import type {
  WorkspaceCleanupCandidate,
  WorkspaceCleanupScanArgs,
  WorkspaceCleanupScanError,
  WorkspaceCleanupScanResult
} from '../../shared/workspace-cleanup'
import {
  handleRepoWorktreeListError,
  listCleanupGitWorktrees
} from './workspace-cleanup-worktree-listing'
import type { WorkspaceCleanupGitRoute } from './workspace-cleanup-git-route'
import { shouldScanBroadWorkspaceCleanupWorktree } from './workspace-cleanup-scan-eligibility'
import {
  resolvePersistedWorkspaceCleanupActivityWorktree,
  resolveWorkspaceCleanupActivityWorktree,
  type WorkspaceCleanupFsActivityCache
} from './workspace-cleanup-activity'
import {
  buildWorkspaceCleanupCandidate,
  buildWorkspaceCleanupCandidateFromError,
  isWorkspaceInactiveForCleanup
} from './workspace-cleanup-candidate'
import { synthesizeDisconnectedSshCleanupCandidates } from './workspace-cleanup-disconnected-ssh'
import {
  WORKSPACE_CLEANUP_GIT_READ_TIMEOUT_MS,
  WorkspaceCleanupScanCancelledError,
  appendWorkspaceCleanupItems,
  mapWorkspaceCleanupWithConcurrency,
  throwIfWorkspaceCleanupScanAborted,
  withWorkspaceCleanupTimeout
} from './workspace-cleanup-scan-primitives'
import { listWorkspaceCleanupFolderWorkspaces } from './workspace-cleanup-folder-workspaces'
import {
  createWorkspaceCleanupProgressEmitter,
  type WorkspaceCleanupScanOptions
} from './workspace-cleanup-progress-emitter'
import {
  getTargetWorktreeIdsByRepo,
  hasTargetedWorkspaceCleanupScan
} from './workspace-cleanup-scan-targets'
import { isWorktreeMetaOwnedByRepo } from '../worktree-metadata-ownership'

const WORKTREE_SCAN_CONCURRENCY = 3
// Overlap repo scans to avoid summing SSH listing round-trip latency.
const REPO_SCAN_CONCURRENCY = 2

type WorkspaceCleanupScanRepoProgress = {
  onWorktreesDiscovered?: (count: number) => void
  onCandidateScanned?: (candidate: WorkspaceCleanupCandidate) => void
  onErrors?: (errors: WorkspaceCleanupScanError[]) => void
}

export async function scanWorkspaceCleanup(
  store: Store,
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
  const repos =
    targetWorktreeIdsByRepo.size > 0
      ? allRepos.filter((repo) => targetWorktreeIdsByRepo.has(repo.id))
      : allRepos
  const repoOwnerCountById = new Map<string, number>()
  for (const repo of allRepos) {
    repoOwnerCountById.set(repo.id, (repoOwnerCountById.get(repo.id) ?? 0) + 1)
  }
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
    store: Store
    repo: Repo
    repoOwnerCount: number
    scannedAt: number
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
          : await resolveCleanupActivityWithTimeout(
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
        // Defer Git for active rows during fleet scans; forced removal preflight reads fresh evidence.
        skipGit: skipGitWorktreeIds.has(worktreeWithActivity.id) || !isInactive,
        forceGitCheck: Boolean(targetWorktreeIds),
        signal
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

async function resolveCleanupActivityWithTimeout(
  route: WorkspaceCleanupGitRoute,
  worktree: Worktree,
  onActivityStatsUnavailable: () => void,
  signal?: AbortSignal,
  fsActivityCache?: WorkspaceCleanupFsActivityCache
): Promise<Worktree> {
  try {
    return await withWorkspaceCleanupTimeout(
      () =>
        resolveWorkspaceCleanupActivityWorktree(
          route,
          worktree,
          undefined,
          undefined,
          fsActivityCache
        ),
      WORKSPACE_CLEANUP_GIT_READ_TIMEOUT_MS,
      'Timed out reading worktree activity.',
      signal
    )
  } catch (error) {
    if (error instanceof WorkspaceCleanupScanCancelledError) {
      throw error
    }
    onActivityStatsUnavailable()
    console.warn('Workspace cleanup activity scan failed', error)
    return resolvePersistedWorkspaceCleanupActivityWorktree(worktree)
  }
}
