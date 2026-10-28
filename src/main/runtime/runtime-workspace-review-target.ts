import { getRepoRoutingConnectionId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import { CLEARED_HOSTED_REVIEW_SELECTION_UPDATES } from '../../shared/worktree/hosted-review-links'
import { gitExecFileAsync } from '../git/runner'
import { requireReachableGitRoute } from '../providers/execution-host-provider-dispatch'
import { blockedWslDistroForPath } from '../wsl/wsl-unc-access-gate'
import { readWorkspaceReviewPR } from '../../shared/sidebar-list/workspace-review-facts'
import {
  shouldApplyBranchMismatchedLinkedPRClear,
  shouldClearBranchMismatchedLinkedOpenPR,
  shouldClearDivergedLinkedMergedPR
} from '../../shared/github/linked-pr-staleness'
import type { GitHubPRRefreshCandidate } from '../../shared/github/pull-request-refresh-types'
import {
  getGitHubPRCacheKey,
  getGitHubPRCacheKeyCandidates
} from '../../shared/github/github-cache-key'
import type { Repo } from '../../shared/repo-types'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { RuntimeStore } from './runtime-store-contract'
import type { ExecutionHostId } from '../../shared/execution-host'
import { getForgeProviderForRepository } from '../source-control/forge-provider'
import { hostedReviewSshConnectionId } from '../source-control/hosted-review-execution-host'
import {
  cachedPRCandidateFields,
  selectPRRefreshFallback
} from '../../shared/github/pr-refresh-selection'

export type WorkspaceReviewTarget = {
  worktreeId: string
  branch: string
  candidate: GitHubPRRefreshCandidate | null
  linkedPR?: number | null
  suppressedGitHubPR?: number | null
  pushTargetBranch?: string | null
}

export async function workspaceReviewTarget(args: {
  worktree: Pick<
    ResolvedWorktree,
    | 'id'
    | 'path'
    | 'branch'
    | 'git'
    | 'isArchived'
    | 'linkedPR'
    | 'suppressedGitHubPR'
    | 'pushTarget'
  >
  repo?: Repo
  executionHostId: ExecutionHostId
  localGitOptions?: { wslDistro?: string }
  store: Pick<
    RuntimeStore,
    'getGitHubCache' | 'setGitHubCache' | 'getWorktreeMetaForHost' | 'setWorktreeMeta'
  >
}): Promise<WorkspaceReviewTarget> {
  const { worktree, repo, executionHostId, localGitOptions, store } = args
  let branch = worktree.branch.replace(/^refs\/heads\//, '')
  let head = worktree.git.head || null
  const neutral: WorkspaceReviewTarget = { worktreeId: worktree.id, branch, candidate: null }
  if (!repo || repo.kind === 'folder' || worktree.isArchived || worktree.git.isBare) {
    return neutral
  }
  requireReachableGitRoute(executionHostId)
  if (await blockedWslDistroForPath(worktree.path, localGitOptions?.wslDistro)) {
    return neutral
  }
  const provider = await getForgeProviderForRepository({
    repoPath: repo.path,
    executionHostId,
    localGitExecOptions: { ...localGitOptions, admissionTier: 'background' }
  })
  if (provider?.id !== 'github') {
    return neutral
  }
  const identity = await gitExecFileAsync(['rev-parse', 'HEAD', '--symbolic-full-name', 'HEAD'], {
    cwd: worktree.path,
    ...localGitOptions,
    admissionTier: 'background'
  })
  const [oid, ref] = identity.stdout.trim().split(/\r?\n/)
  head = oid || null
  branch = ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ''
  if (!branch || !head) {
    return { ...neutral, branch }
  }
  const cacheKey = getGitHubPRCacheKey(
    repo.path,
    repo.id,
    branch,
    undefined,
    getRepoRoutingConnectionId(repo),
    executionHostId
  )
  const cached = store.getGitHubCache().pr[cacheKey]
  const latestMeta = store.getWorktreeMetaForHost?.(worktree.id, executionHostId)
  const selection = { ...worktree, ...latestMeta, branch }
  const reviewRepo = { ...repo, executionHostId }
  const cachedPR = readWorkspaceReviewPR(selection, reviewRepo, store.getGitHubCache().pr)
  const staleLinked =
    shouldClearBranchMismatchedLinkedOpenPR({
      pr: cachedPR,
      linkedPRNumber: selection.linkedPR ?? null,
      branch,
      requestHeadOid: head,
      pushTargetBranch: selection.pushTarget?.branchName ?? null
    }) ||
    shouldClearDivergedLinkedMergedPR({
      pr: cachedPR,
      linkedPRNumber: selection.linkedPR ?? null,
      requestHeadOid: head
    })
  const canClear =
    staleLinked &&
    selection.linkedPR != null &&
    latestMeta?.linkedPR === selection.linkedPR &&
    shouldApplyBranchMismatchedLinkedPRClear({
      worktree: { ...selection, head, isBare: worktree.git.isBare },
      linkedPRNumber: selection.linkedPR,
      branch,
      requestHeadOid: head
    })
  if (canClear) {
    store.setWorktreeMeta(
      hostWorktreeTarget({ id: worktree.id, hostId: executionHostId }),
      CLEARED_HOSTED_REVIEW_SELECTION_UPDATES
    )
    const cache = store.getGitHubCache()
    const pr = { ...cache.pr }
    const keys =
      executionHostId === LOCAL_EXECUTION_HOST_ID
        ? getGitHubPRCacheKeyCandidates(reviewRepo, branch)
        : [cacheKey]
    for (const key of keys) {
      delete pr[key]
    }
    store.setGitHubCache?.({ ...cache, pr })
  }
  const usableCached =
    staleLinked || (selection.linkedPR != null && cached?.data?.number !== selection.linkedPR)
      ? undefined
      : cached
  return {
    ...neutral,
    branch,
    linkedPR: canClear ? null : selection.linkedPR,
    suppressedGitHubPR: selection.suppressedGitHubPR,
    pushTargetBranch: selection.pushTarget?.branchName,
    candidate: {
      cacheKey,
      repoId: repo.id,
      repoPath: repo.path,
      repoKind: 'git',
      branch,
      worktreeId: worktree.id,
      executionHostId,
      connectionId: hostedReviewSshConnectionId(executionHostId),
      localGitOptions,
      currentHeadOid: head,
      linkedPRNumber: staleLinked ? null : (selection.linkedPR ?? null),
      ...selectPRRefreshFallback({
        linkedPRNumber: staleLinked ? null : selection.linkedPR,
        cachedPR: usableCached?.data,
        currentHeadOid: head
      }),
      isSelected: true,
      ...cachedPRCandidateFields(usableCached, head)
    }
  }
}
