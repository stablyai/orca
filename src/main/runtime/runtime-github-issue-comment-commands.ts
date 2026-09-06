import type { GitHubCreateIssueFields, GitHubIssueUpdate } from '../../shared/issue-mutation-types'
import type { GitHubOwnerRepo } from '../../shared/github/pull-request-types'
import type { GitHubPRReviewCommentInput } from '../../shared/github/comment-types'
import type { Repo } from '../../shared/repo-types'
import {
  addIssueComment,
  addPRReviewComment,
  addPRReviewCommentReply,
  createIssue,
  updateIssue
} from '../github/client'

type LocalGitArgs = [] | [{ wslDistro?: string }]

type RuntimeGitHubIssueCommentCommandsDeps = {
  resolveRepo: (selector: string) => Promise<Repo>
  getLocalGitArgs: (repo: Repo) => LocalGitArgs
}

export class RuntimeGitHubIssueCommentCommands {
  constructor(private readonly deps: RuntimeGitHubIssueCommentCommandsDeps) {}

  async createRepoIssue(
    repoSelector: string,
    title: string,
    body: string,
    fields?: GitHubCreateIssueFields
  ): Promise<Awaited<ReturnType<typeof createIssue>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return createIssue(
      repo.path,
      title,
      body,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      fields,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async updateRepoIssue(
    repoSelector: string,
    number: number,
    updates: GitHubIssueUpdate
  ): Promise<Awaited<ReturnType<typeof updateIssue>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return updateIssue(
      repo.path,
      number,
      updates,
      repo.connectionId ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async addRepoIssueComment(
    repoSelector: string,
    number: number,
    body: string,
    prRepo?: GitHubOwnerRepo | null
  ): Promise<Awaited<ReturnType<typeof addIssueComment>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return addIssueComment(
      repo.path,
      number,
      body,
      repo.connectionId ?? null,
      prRepo ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async addRepoPRReviewComment(
    repoSelector: string,
    args: Omit<GitHubPRReviewCommentInput, 'repoPath'>
  ): Promise<Awaited<ReturnType<typeof addPRReviewComment>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return addPRReviewComment({
      repoPath: repo.path,
      connectionId: repo.connectionId ?? null,
      localGitOptions: this.deps.getLocalGitArgs(repo)[0],
      ...args
    })
  }

  async addRepoPRReviewCommentReply(
    repoSelector: string,
    args: {
      prNumber: number
      commentId: number
      body: string
      threadId?: string
      path?: string
      line?: number
      prRepo?: GitHubOwnerRepo | null
    }
  ): Promise<Awaited<ReturnType<typeof addPRReviewCommentReply>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return addPRReviewCommentReply(
      repo.path,
      args.prNumber,
      args.commentId,
      args.body,
      args.threadId,
      args.path,
      args.line,
      repo.connectionId ?? null,
      args.prRepo ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
  }
}
