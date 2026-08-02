import type { Store } from '../persistence'
import { listRepoWorktrees, createFolderWorktree } from '../repo-worktrees'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import type { IGitProvider } from '../providers/types'
import { isFolderRepo } from '../../shared/repo-kind'
import type { GitWorktreeInfo, Repo, Worktree } from '../../shared/types'
import { mergeWorktree } from './worktree-logic'
import { splitWorktreeId } from '../../shared/worktree-id'
import type {
  WorkspaceCleanupCandidate,
  WorkspaceCleanupScanError,
  WorkspaceCleanupScanArgs,
  WorkspaceCleanupScanProgress,
  WorkspaceCleanupScanResult
} from '../../shared/workspace-cleanup'
import {
  getPersistedWorkspaceCleanupActivityAt,
  resolvePersistedWorkspaceCleanupActivityWorktree,
  resolveWorkspaceCleanupActivityWorktree
} from './workspace-cleanup-activity'
import {
  buildWorkspaceCleanupCandidate,
  buildWorkspaceCleanupCandidateFromError,
  isWorkspaceInactiveForCleanup
} from './workspace-cleanup-candidate'
import { synthesizeDisconnectedSshCleanupCandidates } from './workspace-cleanup-disconnected-ssh'
import {
  WORKSPACE_CLEANUP_GIT_READ_TIMEOUT_MS,
  appendWorkspaceCleanupItems,
  createWorkspaceCleanupScanError,
  mapWorkspaceCleanupWithConcurrency,
  toSafeWorkspaceCleanupRepoScanError,
  withWorkspaceCleanupTimeout
} from './workspace-cleanup-scan-primitives'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'

const WORKTREE_SCAN_CONCURRENCY = 3

type WorkspaceCleanupScanOptions = {
  onProgress?: (progress: WorkspaceCleanupScanProgress) => void
}

type WorkspaceCleanupScanRepoProgress = {
  onWorktreesDiscovered?: (count: number) => void
  onCandidateScanned?: (candidate: WorkspaceCleanupCandidate) => void
  onErrors?: (errors: WorkspaceCleanupScanError[]) => void
}

type WorkspaceCleanupProgressEmitter = {
  addDiscovered: (count: number) => void
  addCandidate: (candidate: WorkspaceCleanupCandidate) => void
  addErrors: (errors: WorkspaceCleanupScanError[]) => void
}

export async function scanWorkspaceCleanup(
  store: Store,
  args: WorkspaceCleanupScanArgs = {},
  options: WorkspaceCleanupScanOptions = {}
): Promise<WorkspaceCleanupScanResult> {
  const scannedAt = Date.now()
  const parsedTarget = args.worktreeId ? splitWorktreeId(args.worktreeId) : null
  if (args.worktreeId && !parsedTarget) {
    return { scannedAt, candidates: [], errors: [] }
  }
  const repos = parsedTarget
    ? store.getRepos().filter((repo) => repo.id === parsedTarget.repoId)
    : store.getRepos()
  const progress = createProgressEmitter(args.scanId, scannedAt, options)
  const errors: WorkspaceCleanupScanResult['errors'] = []
  const candidates: WorkspaceCleanupCandidate[] = []

  for (const repo of repos) {
    const result = await scanRepoWorkspaces({
      store,
      repo,
      scannedAt,
      targetWorktreeId: args.worktreeId,
      skipGitWorktreeIds: new Set(args.skipGitWorktreeIds ?? []),
      onWorktreesDiscovered: progress.addDiscovered,
      onCandidateScanned: progress.addCandidate,
      onErrors: progress.addErrors
    })
    appendWorkspaceCleanupItems(candidates, result.candidates)
    appendWorkspaceCleanupItems(errors, result.errors)
  }

  return { scannedAt, candidates, errors }
}

async function scanRepoWorkspaces(
  args: {
    store: Store
    repo: Repo
    scannedAt: number
    targetWorktreeId?: string
    skipGitWorktreeIds: Set<string>
  } & WorkspaceCleanupScanRepoProgress
): Promise<WorkspaceCleanupScanResult> {
  const {
    store,
    repo,
    scannedAt,
    targetWorktreeId,
    skipGitWorktreeIds,
    onWorktreesDiscovered,
    onCandidateScanned,
    onErrors
  } = args
  const errors: WorkspaceCleanupScanResult['errors'] = []
  const repoIsFolder = isFolderRepo(repo)
  let provider: IGitProvider | null = null
  let gitWorktrees: GitWorktreeInfo[] = []

  try {
    const discovered = await listCleanupGitWorktrees(store, repo, repoIsFolder)
    provider = discovered.provider
    gitWorktrees = discovered.gitWorktrees
  } catch (error) {
    return handleRepoWorktreeListError({ repo, targetWorktreeId, scannedAt, error, onErrors })
  }

  if (repo.connectionId && !provider) {
    const candidates = targetWorktreeId
      ? synthesizeDisconnectedSshCleanupCandidates(store, repo, scannedAt, targetWorktreeId)
      : []
    onWorktreesDiscovered?.(candidates.length)
    for (const candidate of candidates) {
      onCandidateScanned?.(candidate)
    }
    return { scannedAt, candidates, errors: [] }
  }

  const mergedWorktrees = gitWorktrees.map((gitWorktree) => {
    const worktreeId = `${repo.id}::${gitWorktree.path}`
    const meta = store.getWorktreeMeta(worktreeId)
    return mergeWorktree(repo.id, gitWorktree, meta, repo.displayName)
  })
  const candidateWorktrees = targetWorktreeId
    ? mergedWorktrees.filter((worktree) => worktree.id === targetWorktreeId)
    : mergedWorktrees.filter((worktree) =>
        shouldResolveBroadWorkspaceCleanupActivity(repoIsFolder, worktree, scannedAt)
      )
  // Why: fs stat has no cancellation, so on a hung network/WSL mount every
  // timed-out row would abandon more threadpool work. After the first timeout,
  // stop statting this repo and use persisted activity only.
  let activityStatsUnavailable = false
  const candidatesWithSkipped = await mapWorkspaceCleanupWithConcurrency(
    candidateWorktrees,
    WORKTREE_SCAN_CONCURRENCY,
    async (worktree) => {
      // Why: externally-created worktrees can miss Orca activity stamps; local
      // filesystem metadata is a conservative guard before suggesting deletion.
      const worktreeWithActivity = activityStatsUnavailable
        ? resolvePersistedWorkspaceCleanupActivityWorktree(worktree)
        : await resolveCleanupActivityWithTimeout(repo, worktree, () => {
            activityStatsUnavailable = true
          })
      if (!targetWorktreeId && !isWorkspaceInactiveForCleanup(worktreeWithActivity, scannedAt)) {
        return null
      }
      onWorktreesDiscovered?.(1)
      const candidate = await buildWorkspaceCleanupCandidate({
        repo,
        worktree: worktreeWithActivity,
        scannedAt,
        provider,
        skipGit: skipGitWorktreeIds.has(worktreeWithActivity.id),
        forceGitCheck: Boolean(targetWorktreeId)
      }).catch((error) => {
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
  onActivityStatsUnavailable: () => void
): Promise<Worktree> {
  try {
    return await withWorkspaceCleanupTimeout(
      () => resolveWorkspaceCleanupActivityWorktree(repo, worktree),
      WORKSPACE_CLEANUP_GIT_READ_TIMEOUT_MS,
      'Timed out reading worktree activity.'
    )
  } catch (error) {
    onActivityStatsUnavailable()
    console.warn('Workspace cleanup activity scan failed', error)
    return resolvePersistedWorkspaceCleanupActivityWorktree(worktree)
  }
}

function shouldResolveBroadWorkspaceCleanupActivity(
  repoIsFolder: boolean,
  worktree: Worktree,
  scannedAt: number
): boolean {
  if (repoIsFolder || worktree.isMainWorktree) {
    return false
  }
  return isWorkspaceInactiveForCleanup(
    {
      isArchived: worktree.isArchived,
      lastActivityAt: getPersistedWorkspaceCleanupActivityAt(worktree)
    },
    scannedAt
  )
}

async function listCleanupGitWorktrees(
  store: Store,
  repo: Repo,
  repoIsFolder: boolean
): Promise<{ provider: IGitProvider | null; gitWorktrees: GitWorktreeInfo[] }> {
  if (repoIsFolder) {
    return { provider: null, gitWorktrees: [createFolderWorktree(repo)] }
  }
  if (repo.connectionId) {
    const provider = getSshGitProvider(repo.connectionId) ?? null
    if (!provider) {
      // Why: cleanup should reflect only workspaces Orca can currently inspect.
      return { provider: null, gitWorktrees: [] }
    }
    return {
      provider,
      gitWorktrees: await withWorkspaceCleanupTimeout(
        (signal) => provider.listWorktrees(repo.path, { signal }),
        WORKSPACE_CLEANUP_GIT_READ_TIMEOUT_MS,
        'Timed out listing SSH worktrees.'
      )
    }
  }
  const localGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  return {
    provider: null,
    gitWorktrees: await withWorkspaceCleanupTimeout(
      (signal) => listRepoWorktrees(repo, { ...localGitOptions, signal }),
      WORKSPACE_CLEANUP_GIT_READ_TIMEOUT_MS,
      'Timed out listing worktrees.'
    )
  }
}

function handleRepoWorktreeListError(args: {
  repo: Repo
  targetWorktreeId?: string
  scannedAt: number
  error: unknown
  onErrors?: (errors: WorkspaceCleanupScanError[]) => void
}): WorkspaceCleanupScanResult {
  const { repo, targetWorktreeId, scannedAt, error, onErrors } = args
  console.error('Workspace cleanup repo scan failed', error)
  if (repo.connectionId && !targetWorktreeId) {
    // Why: broad cleanup only shows remote workspaces Orca can inspect now.
    // A connected SSH repo that fails mid-scan is omitted, not bannered.
    return { scannedAt, candidates: [], errors: [] }
  }
  const errors = [createWorkspaceCleanupScanError(repo, toSafeWorkspaceCleanupRepoScanError(error))]
  onErrors?.(errors)
  return { scannedAt, candidates: [], errors }
}

function createProgressEmitter(
  scanId: string | undefined,
  scannedAt: number,
  options: WorkspaceCleanupScanOptions
): WorkspaceCleanupProgressEmitter {
  const errors: WorkspaceCleanupScanError[] = []
  let totalWorktreeCount = 0
  let scannedWorktreeCount = 0
  const emit = (
    candidates: WorkspaceCleanupCandidate[],
    candidateMode: WorkspaceCleanupScanProgress['candidateMode'] = 'snapshot'
  ): void => {
    if (!scanId) {
      return
    }
    options.onProgress?.({
      scanId,
      scannedAt,
      totalWorktreeCount,
      scannedWorktreeCount,
      candidates,
      errors: [...errors],
      candidateMode
    })
  }
  return {
    addDiscovered: (count) => {
      totalWorktreeCount += count
      emit([], 'append')
    },
    addCandidate: (candidate) => {
      scannedWorktreeCount += 1
      emit([candidate], 'append')
    },
    addErrors: (newErrors) => {
      appendWorkspaceCleanupItems(errors, newErrors)
      emit([], 'append')
    }
  }
}
