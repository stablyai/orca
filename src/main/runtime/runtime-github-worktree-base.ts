import type { GitHubPrStartPoint } from '../../shared/worktree/types'
import type { Repo } from '../../shared/repo-types'
import {
  fetchPrHeadTrackingRef,
  fetchGitHubPullRequestHeadRef
} from '../github/pr-head-tracking-ref'
import { resolveGitHubPrStartPoint } from '../github/pr-start-point'
import { resolveGitHubReviewHeadRemote } from '../github/review-head-remote'
import { gitExecFileAsync } from '../git/runner'
import {
  getLocalProjectGitExecOptions,
  getLocalProjectGhExecOptions
} from '../project-runtime-git-options'
import { isFolderRepo } from '../../shared/repo-kind'
import { requireRepoLocalGitRoute } from '../repo-execution-host'
import type { ProjectRuntimeResolutionStore } from '../local-project-runtime-resolution'

export type RuntimeGitHubWorktreeBaseArgs = {
  repoSelector: string
  prNumber: number
  headRefName?: string
  baseRefName?: string
  isCrossRepository?: boolean
}

export async function resolveRuntimeGitHubWorktreeBase(
  args: RuntimeGitHubWorktreeBaseArgs,
  deps: {
    store: ProjectRuntimeResolutionStore | null
    resolveRepo: (selector: string) => Promise<Repo>
  }
): Promise<GitHubPrStartPoint | { error: string }> {
  if (!deps.store) {
    throw new Error('runtime_unavailable')
  }
  let repo: Repo
  try {
    repo = await deps.resolveRepo(args.repoSelector)
  } catch {
    return { error: 'Repo not found' }
  }
  if (isFolderRepo(repo)) {
    return { error: 'Folder mode does not support creating worktrees.' }
  }
  // Use shared host gating: executionHostId may be a row's only SSH marker.
  requireRepoLocalGitRoute(repo)
  const localGitExecOptions = getLocalProjectGitExecOptions(deps.store, repo)
  const localGhOptions = getLocalProjectGhExecOptions(deps.store, repo)
  const gitExec = (gitArgs: string[]) => gitExecFileAsync(gitArgs, localGitExecOptions)
  const resolveRemote = (): Promise<string> =>
    resolveGitHubReviewHeadRemote({
      repoPath: repo.path,
      issueSourcePreference: repo.issueSourcePreference,
      connectionId: null,
      localGitOptions: localGhOptions,
      gitExec
    })
  const fetchRemoteTrackingRef = (remote: string, branch: string): Promise<void> =>
    fetchPrHeadTrackingRef(repo, remote, branch, { localGitExecOptions })
  const fetchPullRequestHeadRef = (remote: string, prNumber: number): Promise<string> =>
    fetchGitHubPullRequestHeadRef(repo, remote, prNumber, {
      localGitExecOptions
    })
  return resolveGitHubPrStartPoint({
    repoPath: repo.path,
    prNumber: args.prNumber,
    headRefName: args.headRefName,
    baseRefName: args.baseRefName,
    isCrossRepository: args.isCrossRepository,
    issueSourcePreference: repo.issueSourcePreference,
    connectionId: null,
    localGitOptions: localGhOptions,
    gitExec,
    fetchRemoteTrackingRef,
    fetchPullRequestHeadRef,
    resolveRemote
  })
}
