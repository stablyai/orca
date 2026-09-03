import type { Store } from '../persistence'
import type { IGitProvider } from '../providers/types'
import { isFolderRepo } from '../../shared/repo-kind'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { readWorktreeMetaForHost } from '../persistence/host-qualified-worktree-meta'
import type { Repo } from '../../shared/repo-types'
import type { GitWorktreeInfo, Worktree } from '../../shared/worktree/types'
import { mergeWorktree } from './worktree-logic'
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
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { LocalProjectWorktreeGitOptions } from '../project-runtime-git-options'

const WORKTREE_SCAN_CONCURRENCY = 3
// Why: SSH repos pay a worktree-list round trip each; strictly serial repos
// made scan wall-clock the sum of per-repo network latencies.
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
  const scopedRepoId = targetWorktreeIdsByRepo.size > 0 ? null : (args.repoId ?? null)
  const repos =
    targetWorktreeIdsByRepo.size > 0
      ? allRepos.filter((repo) => targetWorktreeIdsByRepo.has(repo.id))
      : scopedRepoId
        ? allRepos.filter(
            (repo) =>
              repo.id === scopedRepoId &&
              // Why: repo ids repeat across execution hosts, so matching the id
              // alone would pull another host's project into a scan the user
              // aimed at one. An absent host id keeps the older, broader match.
              (!args.executionHostId || getRepoExecutionHostId(repo) === args.executionHostId)
          )
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
          scopedRepoScan: scopedRepoId !== null,
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
    scopedRepoScan?: boolean
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
    scopedRepoScan = false,
    skipGitWorktreeIds,
    signal,
    onWorktreesDiscovered,
    onCandidateScanned,
    onErrors
  } = args
  const errors: WorkspaceCleanupScanResult['errors'] = []
  const repoIsFolder = isFolderRepo(repo)
  let localGitOptions: LocalProjectWorktreeGitOptions = {}
  let provider: IGitProvider | null = null
  let gitWorktrees: GitWorktreeInfo[] = []

  try {
    const discovered = await listCleanupGitWorktrees(store, repo, repoIsFolder, signal)
    provider = discovered.provider
    gitWorktrees = discovered.gitWorktrees
    localGitOptions = discovered.localGitOptions
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

  if (repo.connectionId && !provider) {
    // Why: a disconnected host still owns real workspaces; the full list shows
    // them (blocked), while legacy scans keep omitting what they cannot inspect.
    const candidates =
      targetWorktreeIds || includeAllWorkspaces || scopedRepoScan
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
          const hostMeta = readWorktreeMetaForHost(store, worktreeId, getRepoExecutionHostId(repo))
          const meta = store.getWorktreeMeta(worktreeId)
          const ownedMeta =
            hostMeta ?? (isWorktreeMetaOwnedByRepo(repo, meta, repoOwnerCount) ? meta : undefined)
          return mergeWorktree(repo.id, gitWorktree, ownedMeta, repo.displayName)
        })
  // Why: with includeAllWorkspaces the browser shows every workspace and lets
  // filters narrow it; an age threshold here would hide rows from all views.
  const candidateWorktrees = targetWorktreeIds
    ? mergedWorktrees.filter((worktree) => targetWorktreeIds.has(worktree.id))
    : mergedWorktrees.filter((worktree) =>
        shouldScanBroadWorkspaceCleanupWorktree({
          // Why: a project-scoped scan wants every workspace listed for the same
          // reason the full browser does — the idle threshold would hide the
          // branch that merged this morning.
          includeAllWorkspaces: includeAllWorkspaces || scopedRepoScan,
          repoIsFolder,
          worktree,
          scannedAt
        })
      )
  // Why: with a target list or the full-list browser, every filtered row will
  // be reported; counting them upfront keeps the progress bar honest instead
  // of advancing discovered/scanned in lockstep at ~100%.
  const reportDiscoveredUpfront = targetWorktreeIds !== undefined || includeAllWorkspaces
  if (reportDiscoveredUpfront && candidateWorktrees.length > 0) {
    onWorktreesDiscovered?.(candidateWorktrees.length)
  }
  // Why: fs stat has no cancellation, so on a hung network/WSL mount every
  // timed-out row would abandon more threadpool work. After the first timeout,
  // stop statting this repo and use persisted activity only.
  let activityStatsUnavailable = false
  const fsActivityCache: WorkspaceCleanupFsActivityCache = new Map()
  const candidatesWithSkipped = await mapWorkspaceCleanupWithConcurrency(
    candidateWorktrees,
    WORKTREE_SCAN_CONCURRENCY,
    async (worktree) => {
      throwIfWorkspaceCleanupScanAborted(signal)
      // Why: externally-created worktrees can miss Orca activity stamps; local
      // filesystem metadata is a conservative guard before suggesting deletion.
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
              repo,
              worktree,
              () => {
                activityStatsUnavailable = true
              },
              signal,
              fsActivityCache
            )
      const isInactive = isWorkspaceInactiveForCleanup(worktreeWithActivity, scannedAt)
      if (!targetWorktreeIds && !includeAllWorkspaces && !scopedRepoScan && !isInactive) {
        return null
      }
      if (!reportDiscoveredUpfront) {
        onWorktreesDiscovered?.(1)
      }
      const candidate = await buildWorkspaceCleanupCandidate({
        repo,
        worktree: worktreeWithActivity,
        scannedAt,
        provider,
        // Why: full-fleet scans defer git for recently active rows; removal preflight
        // forces a fresh read before any selected row can be deleted.
        skipGit: skipGitWorktreeIds.has(worktreeWithActivity.id) || !isInactive,
        // Why: the merge proof is the whole point of a project-scoped scan, and
        // it lives behind the git read that idle rows would otherwise skip.
        forceGitCheck: Boolean(targetWorktreeIds) || scopedRepoScan,
        signal,
        localGitOptions
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
  repo: Repo,
  worktree: Worktree,
  onActivityStatsUnavailable: () => void,
  signal?: AbortSignal,
  fsActivityCache?: WorkspaceCleanupFsActivityCache
): Promise<Worktree> {
  try {
    return await withWorkspaceCleanupTimeout(
      () =>
        resolveWorkspaceCleanupActivityWorktree(
          repo,
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
