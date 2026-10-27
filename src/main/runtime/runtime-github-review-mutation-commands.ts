import type { GitHubOwnerRepo } from '../../shared/github/pull-request-types'
import type { GitHubPullRequestStateUpdate } from '../../shared/issue-mutation-types'
import type { GitHubReactionContent } from '../../shared/github/comment-types'
import type { Repo } from '../../shared/repo-types'
import type { LocalProjectGhExecOptions } from '../project-runtime-git-options'
import {
  mergePR,
  markPRReadyForReview,
  removePRReviewers,
  requestPRReviewers,
  rerunPRChecks,
  resolveReviewThread,
  setPRAutoMerge,
  setPRCommentReaction,
  setPRFileViewed,
  updatePRDetails,
  updatePRState,
  updatePRTitle
} from '../github/client'
import { getRepoRoutingConnectionId } from '../../shared/execution-host'

type LocalGitArgs = [] | [LocalProjectGhExecOptions]

type RuntimeGitHubReviewMutationCommandsDeps = {
  resolveRepo: (selector: string) => Promise<Repo>
  getLocalGitArgs: (repo: Repo) => LocalGitArgs
}

export class RuntimeGitHubReviewMutationCommands {
  constructor(private readonly deps: RuntimeGitHubReviewMutationCommandsDeps) {}

  async rerunRepoPRChecks(
    repoSelector: string,
    prNumber: number,
    options?: { headSha?: string; failedOnly?: boolean; prRepo?: GitHubOwnerRepo | null }
  ): Promise<Awaited<ReturnType<typeof rerunPRChecks>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return rerunPRChecks(
      repo.path,
      prNumber,
      options,
      getRepoRoutingConnectionId(repo),
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async setRepoPRCommentReaction(
    repoSelector: string,
    reactionSubjectId: string,
    content: GitHubReactionContent,
    reacted: boolean,
    prRepo?: GitHubOwnerRepo | null
  ): Promise<Awaited<ReturnType<typeof setPRCommentReaction>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return setPRCommentReaction(
      repo.path,
      reactionSubjectId,
      content,
      reacted,
      getRepoRoutingConnectionId(repo),
      prRepo ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async resolveRepoReviewThread(
    repoSelector: string,
    threadId: string,
    resolve: boolean,
    prRepo?: GitHubOwnerRepo | null
  ): Promise<Awaited<ReturnType<typeof resolveReviewThread>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return resolveReviewThread(
      repo.path,
      threadId,
      resolve,
      getRepoRoutingConnectionId(repo),
      prRepo ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async setRepoPRFileViewed(
    repoSelector: string,
    args: {
      prRepo?: GitHubOwnerRepo | null
      pullRequestId: string
      path: string
      viewed: boolean
    }
  ): Promise<Awaited<ReturnType<typeof setPRFileViewed>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return setPRFileViewed({
      repoPath: repo.path,
      connectionId: getRepoRoutingConnectionId(repo),
      localGitOptions: this.deps.getLocalGitArgs(repo)[0],
      ...args
    })
  }

  async updateRepoPRTitle(
    repoSelector: string,
    prNumber: number,
    title: string,
    prRepo?: GitHubOwnerRepo | null
  ): Promise<Awaited<ReturnType<typeof updatePRTitle>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return updatePRTitle(
      repo.path,
      prNumber,
      title,
      getRepoRoutingConnectionId(repo),
      prRepo ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async updateRepoPRDetails(
    repoSelector: string,
    prNumber: number,
    updates: { title?: string; body?: string },
    prRepo?: GitHubOwnerRepo | null
  ): Promise<Awaited<ReturnType<typeof updatePRDetails>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return updatePRDetails(
      repo.path,
      prNumber,
      updates,
      getRepoRoutingConnectionId(repo),
      prRepo ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async mergeRepoPR(
    repoSelector: string,
    prNumber: number,
    method?: 'merge' | 'squash' | 'rebase',
    prRepo?: GitHubOwnerRepo | null
  ): Promise<Awaited<ReturnType<typeof mergePR>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return mergePR(
      repo.path,
      prNumber,
      method,
      getRepoRoutingConnectionId(repo),
      prRepo ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async setRepoPRAutoMerge(
    repoSelector: string,
    prNumber: number,
    enabled: boolean,
    method?: 'merge' | 'squash' | 'rebase',
    prRepo?: GitHubOwnerRepo | null
  ): Promise<Awaited<ReturnType<typeof setPRAutoMerge>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return setPRAutoMerge(
      repo.path,
      prNumber,
      enabled,
      method,
      getRepoRoutingConnectionId(repo),
      prRepo ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async markRepoPRReadyForReview(
    repoSelector: string,
    prNumber: number,
    prRepo?: GitHubOwnerRepo | null
  ): Promise<Awaited<ReturnType<typeof markPRReadyForReview>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return markPRReadyForReview(
      repo.path,
      prNumber,
      getRepoRoutingConnectionId(repo),
      prRepo ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async updateRepoPRState(
    repoSelector: string,
    prNumber: number,
    updates: GitHubPullRequestStateUpdate,
    prRepo?: GitHubOwnerRepo | null
  ): Promise<Awaited<ReturnType<typeof updatePRState>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return updatePRState(
      repo.path,
      prNumber,
      updates,
      getRepoRoutingConnectionId(repo),
      prRepo ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async requestRepoPRReviewers(
    repoSelector: string,
    prNumber: number,
    reviewers: string[],
    prRepo?: GitHubOwnerRepo | null
  ): Promise<Awaited<ReturnType<typeof requestPRReviewers>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return requestPRReviewers(
      repo.path,
      prNumber,
      reviewers,
      getRepoRoutingConnectionId(repo),
      prRepo ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async removeRepoPRReviewers(
    repoSelector: string,
    prNumber: number,
    reviewers: string[],
    prRepo?: GitHubOwnerRepo | null
  ): Promise<Awaited<ReturnType<typeof removePRReviewers>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return removePRReviewers(
      repo.path,
      prNumber,
      reviewers,
      getRepoRoutingConnectionId(repo),
      prRepo ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
  }
}
