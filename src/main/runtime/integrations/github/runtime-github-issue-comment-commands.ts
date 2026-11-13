import '../../../github/api/rate-limit'
import type {
  GitHubCreateIssueFields,
  GitHubIssueUpdate
} from '../../../../shared/issue-mutation-types'
import type { GitHubRepositoryIdentity as GitHubOwnerRepo } from '../../../../shared/github/repositories/repository-identity'
import type { GitHubPRReviewCommentInput } from '../../../../shared/github/comments/comment-types'
import type { Repo } from '../../../../shared/repo-types'
import type { LocalProjectGhExecOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import { addIssueComment } from '../../../github/issues/issue-comment'
import {
  addPRReviewComment,
  addPRReviewCommentReply
} from '../../../github/client/create/add-pr-review-comment'
import { createIssue } from '../../../github/issues/issue-create'
import { updateIssue } from '../../../github/issues/issue-update'
import { getRepoRoutingConnectionId } from '../../../../shared/execution-host'
import type { GitHubAttachmentTarget } from '../../../../shared/rpc-contract/github-attachment-params'
import { uploadGitHubImage } from '../../../github/attachments/image-attachment-upload'
import {
  resolveGitHubRepoExecution,
  resolveIssueGitHubApiRepositorySource
} from '../../../github/repositories/github-api-repository'
import { projectGhExecOptions } from '../../../github/project-view/project-host-execution'
import { runAsDefaultWslCliUserAct } from '../../../git/command-runner/hosted-cli/default-wsl-cli-fallback'

type LocalGitArgs = [] | [LocalProjectGhExecOptions]

type RuntimeGitHubIssueCommentCommandsDeps = {
  resolveRepo: (selector: string) => Promise<Repo>
  resolveTarget: (args: {
    repoSelector: string
    worktreeSelector?: string
  }) => Promise<{ repo: Repo; repoPath: string }>
  getLocalGitArgs: (repo: Repo) => LocalGitArgs
}

export class RuntimeGitHubIssueCommentCommands {
  constructor(private readonly deps: RuntimeGitHubIssueCommentCommandsDeps) {}

  async uploadGitHubAttachment(
    args: { target: GitHubAttachmentTarget; fileName: string; contentType: string },
    bytes: Buffer,
    signal?: AbortSignal
  ): Promise<{ url: string }> {
    const target = args.target
    const upload = () =>
      uploadGitHubImage({
        ...args,
        bytes,
        signal,
        resolve: async (uploadSignal) => {
          if (target.kind === 'slug') {
            return {
              ownerRepo: target,
              ghOptions: { ...projectGhExecOptions(target.host), signal: uploadSignal }
            }
          }
          const { repo, repoPath } = await this.deps.resolveTarget({
            repoSelector: target.repo,
            worktreeSelector: target.worktree
          })
          const connectionId = getRepoRoutingConnectionId(repo)
          const options = { ...this.deps.getLocalGitArgs(repo)[0], signal: uploadSignal }
          return resolveGitHubRepoExecution(
            repoPath,
            target.ownerRepo ??
              (target.source === 'issue'
                ? async () =>
                    (
                      await resolveIssueGitHubApiRepositorySource(
                        repoPath,
                        repo.issueSourcePreference,
                        connectionId,
                        options
                      )
                    ).source
                : undefined),
            connectionId,
            options
          )
        }
      })
    return target.kind === 'slug' && target.wakeWslDistro
      ? runAsDefaultWslCliUserAct(upload)
      : upload()
  }

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
      getRepoRoutingConnectionId(repo),
      fields,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async updateRepoIssue(
    repoSelector: string,
    number: number,
    updates: GitHubIssueUpdate,
    ownerRepo?: GitHubOwnerRepo
  ): Promise<Awaited<ReturnType<typeof updateIssue>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return updateIssue(
      repo.path,
      number,
      updates,
      getRepoRoutingConnectionId(repo),
      this.deps.getLocalGitArgs(repo)[0],
      repo.issueSourcePreference,
      ...(ownerRepo ? ([ownerRepo] as const) : ([] as const))
    )
  }

  async addRepoIssueComment(
    repoSelector: string,
    number: number,
    body: string,
    prRepo?: GitHubOwnerRepo | null,
    type?: 'issue' | 'pr'
  ): Promise<Awaited<ReturnType<typeof addIssueComment>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return addIssueComment(
      repo.path,
      number,
      body,
      getRepoRoutingConnectionId(repo),
      prRepo ?? null,
      this.deps.getLocalGitArgs(repo)[0],
      // Why: the issue source selector only scopes issues; PR comments keep their resolution.
      type === 'pr' ? undefined : repo.issueSourcePreference
    )
  }

  async addRepoPRReviewComment(
    repoSelector: string,
    args: Omit<GitHubPRReviewCommentInput, 'repoPath'>
  ): Promise<Awaited<ReturnType<typeof addPRReviewComment>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return addPRReviewComment({
      repoPath: repo.path,
      connectionId: getRepoRoutingConnectionId(repo),
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
      getRepoRoutingConnectionId(repo),
      args.prRepo ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
  }
}
