import type { GitHubOwnerRepo, GitHubPRFile } from '../../shared/github/pull-request-types'
import type { Repo } from '../../shared/repo-types'
import type { LocalProjectGhExecOptions } from '../project-runtime-git-options'
import { getIssue, getPRCheckDetails, getPRChecks, getPRComments } from '../github/client'
import {
  getReviewReplyPosts,
  type ReviewReplyPosts
} from '../github/client/fetch/review-reply-posts'
import { getPRFileContents } from '../github/work-item-details'

type LocalGitArgs = [] | [LocalProjectGhExecOptions]

type RuntimeGitHubReviewQueryCommandsDeps = {
  resolveRepo: (selector: string) => Promise<Repo>
  getLocalGitArgs: (repo: Repo) => LocalGitArgs
}

export class RuntimeGitHubReviewQueryCommands {
  constructor(private readonly deps: RuntimeGitHubReviewQueryCommandsDeps) {}

  /** What a review reply may already have posted on this PR, read as the repo's gh account; throws
   *  on any failure (`getReviewReplyPosts`). */
  async getRepoReviewReplyPosts(
    repoSelector: string,
    args: Parameters<typeof getReviewReplyPosts>[1]
  ): Promise<ReviewReplyPosts> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return getReviewReplyPosts(
      repo.path,
      args,
      repo.connectionId ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async getRepoIssue(
    repoSelector: string,
    number: number
  ): Promise<Awaited<ReturnType<typeof getIssue>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return getIssue(
      repo.path,
      number,
      repo.connectionId ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async getRepoPRChecks(
    repoSelector: string,
    prNumber: number,
    headSha?: string,
    prRepo?: GitHubOwnerRepo | null,
    options?: { noCache?: boolean }
  ): Promise<Awaited<ReturnType<typeof getPRChecks>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return getPRChecks(
      repo.path,
      prNumber,
      headSha,
      prRepo ?? null,
      options,
      repo.connectionId ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async getRepoPRCheckDetails(
    repoSelector: string,
    args: {
      checkRunId?: number
      workflowRunId?: number
      checkName?: string
      url?: string | null
      prRepo?: GitHubOwnerRepo | null
    },
    signal?: AbortSignal
  ): Promise<Awaited<ReturnType<typeof getPRCheckDetails>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    const localGitOptions = this.deps.getLocalGitArgs(repo)[0] ?? {}
    return getPRCheckDetails(
      repo.path,
      { ...args, prRepo: args.prRepo ?? null },
      repo.connectionId ?? null,
      localGitOptions,
      signal
    )
  }

  async getRepoPRComments(
    repoSelector: string,
    prNumber: number,
    prRepo?: GitHubOwnerRepo | null,
    options?: { noCache?: boolean }
  ): Promise<Awaited<ReturnType<typeof getPRComments>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return getPRComments(
      repo.path,
      prNumber,
      { ...options, prRepo: prRepo ?? null },
      repo.connectionId ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async getRepoPRFileContents(
    repoSelector: string,
    args: {
      prNumber: number
      prRepo?: GitHubOwnerRepo | null
      path: string
      oldPath?: string
      status: GitHubPRFile['status']
      headSha: string
      baseSha: string
    }
  ): Promise<Awaited<ReturnType<typeof getPRFileContents>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return getPRFileContents({
      repoPath: repo.path,
      connectionId: repo.connectionId ?? null,
      localGitOptions: this.deps.getLocalGitArgs(repo)[0],
      ...args
    })
  }
}
