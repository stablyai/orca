import { isFolderRepo } from '../../../shared/repo-kind'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { getWorktreeExecutionHostId } from '../../../shared/execution-host'
import type { PRInfo } from '../../../shared/github/pull-request-types'
import type { PRCacheView } from '../../../shared/sidebar-list/workspace-review-facts'
import {
  createWorkspaceCleanupFingerprint,
  getWorkspaceCleanupInactivityReasons,
  getWorkspaceCleanupMergeReasons,
  isWorkspaceOldForCleanup,
  type WorkspaceCleanupBlocker,
  type WorkspaceCleanupCandidate,
  type WorkspaceCleanupReason
} from '../../../shared/workspace-cleanup/workspace-cleanup'
import {
  createEmptyWorkspaceCleanupGitEvidence,
  readWorkspaceCleanupGitEvidence
} from './workspace-cleanup-git-evidence'
import { appendWorkspaceCleanupItems } from './workspace-cleanup-scan-primitives'
import {
  getNewestWorkspaceCleanupDiffCommentAt,
  shortWorkspaceCleanupBranchName
} from '../../../shared/workspace-cleanup/workspace-cleanup-candidate-fields'
import type { WorkspaceCleanupGitRoute } from './workspace-cleanup-git-route'

export async function buildWorkspaceCleanupCandidate(args: {
  repo: Repo
  worktree: Worktree
  scannedAt: number
  route: WorkspaceCleanupGitRoute
  prCache: PRCacheView<PRInfo>
  skipGit: boolean
  forceGitCheck: boolean
  signal?: AbortSignal
}): Promise<WorkspaceCleanupCandidate> {
  const { repo, worktree, scannedAt, route, prCache, skipGit, forceGitCheck, signal } = args
  const blockers: WorkspaceCleanupBlocker[] = []
  const reasons = getWorkspaceCleanupInactivityReasonsForWorkspace(worktree, scannedAt)
  const repoIsFolder = isFolderRepo(repo)

  if (worktree.isMainWorktree) {
    blockers.push('main-worktree')
  }
  if (repoIsFolder) {
    blockers.push('folder-repo')
  }
  if (worktree.isPinned) {
    blockers.push('pinned')
  }

  const localContext = buildWorkspaceCleanupLocalContext(worktree)
  const shouldReadGit = shouldReadWorkspaceCleanupGitEvidence({
    repoIsFolder,
    blockers,
    worktree,
    skipGit,
    forceGitCheck
  })

  const gitEvidence = !shouldReadGit
    ? createEmptyWorkspaceCleanupGitEvidence()
    : await readWorkspaceCleanupGitEvidence(worktree, repo, route, prCache, signal)
  appendWorkspaceCleanupItems(blockers, gitEvidence.blockers)
  appendWorkspaceCleanupItems(reasons, getWorkspaceCleanupMergeReasons(gitEvidence.merge))

  const candidateWithoutFingerprint: WorkspaceCleanupCandidate = {
    worktreeId: worktree.id,
    repoId: repo.id,
    repoName: repo.displayName,
    connectionId: repo.connectionId ?? null,
    executionHostId: getWorktreeExecutionHostId(worktree, repo),
    displayName: worktree.displayName,
    branch: shortWorkspaceCleanupBranchName(worktree.branch),
    path: worktree.path,
    reasons,
    blockers: uniqueWorkspaceCleanupBlockers(blockers),
    lastActivityAt: worktree.lastActivityAt,
    ...(worktree.createdAt !== undefined ? { createdAt: worktree.createdAt } : {}),
    localContext,
    git: {
      clean: gitEvidence.clean,
      upstreamAhead: gitEvidence.upstreamAhead,
      upstreamBehind: gitEvidence.upstreamBehind,
      checkedAt: gitEvidence.checkedAt,
      ...(gitEvidence.merge ? { merge: gitEvidence.merge } : {}),
      atRiskLocalFiles: gitEvidence.atRiskLocalFiles
    },
    fingerprint: ''
  }

  const fingerprint = createWorkspaceCleanupFingerprint({
    branch: candidateWithoutFingerprint.branch,
    head: worktree.head,
    gitClean: gitEvidence.clean,
    lastActivityAt: worktree.lastActivityAt
  })

  return {
    ...candidateWithoutFingerprint,
    reasons: uniqueWorkspaceCleanupReasons(reasons),
    blockers: uniqueWorkspaceCleanupBlockers(blockers),
    fingerprint
  }
}

export function buildWorkspaceCleanupCandidateFromError(
  repo: Repo,
  worktree: Worktree,
  scannedAt: number
): WorkspaceCleanupCandidate {
  return {
    worktreeId: worktree.id,
    repoId: repo.id,
    repoName: repo.displayName,
    connectionId: repo.connectionId ?? null,
    executionHostId: getWorktreeExecutionHostId(worktree, repo),
    displayName: worktree.displayName,
    branch: shortWorkspaceCleanupBranchName(worktree.branch),
    path: worktree.path,
    reasons: getWorkspaceCleanupInactivityReasonsForWorkspace(worktree, scannedAt),
    blockers: ['git-status-error'],
    lastActivityAt: worktree.lastActivityAt,
    ...(worktree.createdAt !== undefined ? { createdAt: worktree.createdAt } : {}),
    localContext: buildWorkspaceCleanupLocalContext(worktree),
    git: {
      clean: null,
      upstreamAhead: null,
      upstreamBehind: null,
      checkedAt: scannedAt
    },
    fingerprint: createWorkspaceCleanupFingerprint({
      branch: shortWorkspaceCleanupBranchName(worktree.branch),
      head: worktree.head,
      gitClean: null,
      lastActivityAt: worktree.lastActivityAt
    })
  }
}

export function buildWorkspaceCleanupLocalContext(
  worktree: Pick<Worktree, 'diffComments'>
): WorkspaceCleanupCandidate['localContext'] {
  return {
    terminalTabCount: 0,
    cleanEditorTabCount: 0,
    browserTabCount: 0,
    diffCommentCount: worktree.diffComments?.length ?? 0,
    newestDiffCommentAt: getNewestWorkspaceCleanupDiffCommentAt(worktree.diffComments),
    retainedDoneAgentCount: 0
  }
}

export function isWorkspaceInactiveForCleanup(
  workspace: Pick<Worktree, 'isArchived' | 'lastActivityAt'>,
  scannedAt: number
): boolean {
  return isWorkspaceOldForCleanup(workspace, scannedAt)
}

export function getWorkspaceCleanupInactivityReasonsForWorkspace(
  workspace: Pick<Worktree, 'isArchived' | 'lastActivityAt'>,
  scannedAt: number
): WorkspaceCleanupReason[] {
  return getWorkspaceCleanupInactivityReasons(workspace, scannedAt)
}

function shouldReadWorkspaceCleanupGitEvidence(args: {
  repoIsFolder: boolean
  blockers: WorkspaceCleanupBlocker[]
  worktree: Worktree
  skipGit: boolean
  forceGitCheck: boolean
}): boolean {
  const { repoIsFolder, blockers, worktree, skipGit, forceGitCheck } = args
  if ((skipGit && !forceGitCheck) || repoIsFolder || worktree.isMainWorktree) {
    return false
  }
  // Pinned rows remain removable: defer broad-scan Git work, but require forced confirmation-time evidence.
  if (blockers.includes('pinned') && !forceGitCheck) {
    return false
  }
  if (blockers.includes('main-worktree') || blockers.includes('folder-repo')) {
    return false
  }

  // Inactivity drives recommendations; Git evidence guards dirty and local-only work during removal.
  return true
}

function uniqueWorkspaceCleanupBlockers(
  blockers: WorkspaceCleanupBlocker[]
): WorkspaceCleanupBlocker[] {
  return [...new Set(blockers)]
}

function uniqueWorkspaceCleanupReasons(
  reasons: WorkspaceCleanupReason[]
): WorkspaceCleanupReason[] {
  return [...new Set(reasons)]
}
