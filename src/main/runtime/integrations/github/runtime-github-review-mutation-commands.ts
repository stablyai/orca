import type { GhAccountBinding } from '../../../../shared/github/accounts/account-binding'
import type { GitHubRepositoryIdentity as GitHubOwnerRepo } from '../../../../shared/github/repositories/repository-identity'
import type { GitHubPullRequestStateUpdate } from '../../../../shared/issue-mutation-types'
import type { GitHubReactionContent } from '../../../../shared/github/comments/comment-types'
import type { Repo } from '../../../../shared/repo-types'
import type { LocalProjectGhExecOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import { mergePR } from '../../../github/client/merge/merge-pr'
import { markPRDraft, markPRReadyForReview } from '../../../github/client/update/pr-ready'
import { removePRReviewers, requestPRReviewers } from '../../../github/client/update/pr-reviewers'
import { rerunPRChecks } from '../../../github/client/check/rerun-pr-checks'
import { resolveReviewThread } from '../../../github/client/update/resolve-review-thread'
import { setPRAutoMerge } from '../../../github/client/merge/pr-auto-merge'
import { setPRCommentReaction } from '../../../github/client/update/pr-comment-reaction'
import { setPRFileViewed } from '../../../github/client/update/pr-file-viewed'
import { updatePRDetails, updatePRTitle } from '../../../github/client/update/pr-details'
import { updatePRState } from '../../../github/client/update/pr-state'
import { getRepoRoutingConnectionId } from '../../../../shared/execution-host'

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
      expectedGhAccount?: GhAccountBinding | null
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

  async markRepoPRDraft(
    repoSelector: string,
    prNumber: number,
    prRepo?: GitHubOwnerRepo | null
  ): Promise<Awaited<ReturnType<typeof markPRDraft>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return markPRDraft(
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
