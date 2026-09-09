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
  getLocalProjectWorktreeGitOptions
} from '../project-runtime-git-options'
import { requireSshGitProvider } from '../providers/ssh-git-dispatch'
import { isFolderRepo } from '../../shared/repo-kind'
import type { Store } from '../persistence'

export type RuntimeGitHubWorktreeBaseArgs = {
  repoSelector: string
  prNumber: number
  headRefName?: string
  baseRefName?: string
  isCrossRepository?: boolean
}

export async function resolveRuntimeGitHubWorktreeBase(
  args: RuntimeGitHubWorktreeBaseArgs,
  deps: { store: Store | null; resolveRepo: (selector: string) => Promise<Repo> }
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
  const sshGitProvider = repo.connectionId ? requireSshGitProvider(repo.connectionId) : null
  const localGitExecOptions = sshGitProvider
    ? undefined
    : getLocalProjectGitExecOptions(deps.store, repo)
  const localWorktreeGitOptions = sshGitProvider
    ? {}
    : getLocalProjectWorktreeGitOptions(deps.store, repo)
  const gitExec = sshGitProvider
    ? (gitArgs: string[]) => sshGitProvider.exec(gitArgs, repo.path)
    : (gitArgs: string[]) => gitExecFileAsync(gitArgs, localGitExecOptions ?? { cwd: repo.path })
  const resolveRemote = (): Promise<string> =>
    resolveGitHubReviewHeadRemote({
      repoPath: repo.path,
      issueSourcePreference: repo.issueSourcePreference,
      connectionId: repo.connectionId ?? null,
      localGitOptions: localWorktreeGitOptions,
      gitExec
    })
  const fetchRemoteTrackingRef = (remote: string, branch: string): Promise<void> =>
    fetchPrHeadTrackingRef(
      repo,
      sshGitProvider,
      remote,
      branch,
      localGitExecOptions ? { localGitExecOptions } : {}
    )
  const fetchPullRequestHeadRef = (remote: string, prNumber: number): Promise<string> =>
    fetchGitHubPullRequestHeadRef(
      repo,
      sshGitProvider,
      remote,
      prNumber,
      localGitExecOptions ? { localGitExecOptions } : {}
    )
  return resolveGitHubPrStartPoint({
    repoPath: repo.path,
    prNumber: args.prNumber,
    headRefName: args.headRefName,
    baseRefName: args.baseRefName,
    isCrossRepository: args.isCrossRepository,
    issueSourcePreference: repo.issueSourcePreference,
    connectionId: repo.connectionId ?? null,
    localGitOptions: localWorktreeGitOptions,
    gitExec,
    fetchRemoteTrackingRef,
    fetchPullRequestHeadRef,
    resolveRemote
  })
}
