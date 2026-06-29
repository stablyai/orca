import type { IGitProvider } from '../providers/types'
import { isFolderRepo } from '../../shared/repo-kind'
import type { Repo, Worktree } from '../../shared/types'
import {
  applyWorkspaceCleanupPolicy,
  createWorkspaceCleanupFingerprint,
  getWorkspaceCleanupInactivityReasons,
  isWorkspaceOldForCleanup,
  type WorkspaceCleanupBlocker,
  type WorkspaceCleanupCandidate,
  type WorkspaceCleanupReason
} from '../../shared/workspace-cleanup'
import {
  createEmptyWorkspaceCleanupGitEvidence,
  readWorkspaceCleanupGitEvidence
} from './workspace-cleanup-git-evidence'
import { appendWorkspaceCleanupItems } from './workspace-cleanup-scan-primitives'

export async function buildWorkspaceCleanupCandidate(args: {
  repo: Repo
  worktree: Worktree
  scannedAt: number
  provider: IGitProvider | null
  skipGit: boolean
  forceGitCheck: boolean
}): Promise<WorkspaceCleanupCandidate> {
  const { repo, worktree, scannedAt, provider, skipGit, forceGitCheck } = args
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
    : await readWorkspaceCleanupGitEvidence(worktree, repo, provider)
  appendWorkspaceCleanupItems(blockers, gitEvidence.blockers)

  const candidateWithoutFingerprint: WorkspaceCleanupCandidate = {
    worktreeId: worktree.id,
    repoId: repo.id,
    repoName: repo.displayName,
    connectionId: repo.connectionId ?? null,
    displayName: worktree.displayName,
    branch: shortWorkspaceCleanupBranchName(worktree.branch),
    path: worktree.path,
    tier: 'review',
    selectedByDefault: false,
    reasons,
    blockers: uniqueWorkspaceCleanupBlockers(blockers),
    lastActivityAt: worktree.lastActivityAt,
    ...(worktree.createdAt !== undefined ? { createdAt: worktree.createdAt } : {}),
    localContext,
    git: {
      clean: gitEvidence.clean,
      upstreamAhead: gitEvidence.upstreamAhead,
      upstreamBehind: gitEvidence.upstreamBehind,
      checkedAt: gitEvidence.checkedAt
    },
    fingerprint: ''
  }

  const fingerprint = createWorkspaceCleanupFingerprint({
    branch: candidateWithoutFingerprint.branch,
    head: worktree.head,
    gitClean: gitEvidence.clean,
    lastActivityAt: worktree.lastActivityAt
  })

  return applyWorkspaceCleanupPolicy({
    ...candidateWithoutFingerprint,
    reasons: uniqueWorkspaceCleanupReasons(reasons),
    blockers: uniqueWorkspaceCleanupBlockers(blockers),
    fingerprint
  })
}

export function buildWorkspaceCleanupCandidateFromError(
  repo: Repo,
  worktree: Worktree,
  scannedAt: number
): WorkspaceCleanupCandidate {
  return applyWorkspaceCleanupPolicy({
    worktreeId: worktree.id,
    repoId: repo.id,
    repoName: repo.displayName,
    connectionId: repo.connectionId ?? null,
    displayName: worktree.displayName,
    branch: shortWorkspaceCleanupBranchName(worktree.branch),
    path: worktree.path,
    tier: 'protected',
    selectedByDefault: false,
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
  })
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

export function getNewestWorkspaceCleanupDiffCommentAt(
  diffComments: Worktree['diffComments'] | undefined
): number | null {
  if (!diffComments || diffComments.length === 0) {
    return null
  }
  // Why: persisted diff notes can grow large enough for spread-based Math.max
  // to exceed the JavaScript argument limit during cleanup scans.
  let newest = diffComments[0]?.createdAt ?? null
  for (let index = 1; index < diffComments.length; index += 1) {
    const createdAt = diffComments[index]?.createdAt
    if (createdAt !== undefined && (newest === null || createdAt > newest)) {
      newest = createdAt
    }
  }
  return newest
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

export function shortWorkspaceCleanupBranchName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '') || 'HEAD'
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
  if (
    blockers.includes('pinned') ||
    blockers.includes('main-worktree') ||
    blockers.includes('folder-repo')
  ) {
    return false
  }

  // Why: inactivity is the only recommendation signal now. Git is read only
  // to keep the destructive path from deleting dirty or local-only branch work.
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
