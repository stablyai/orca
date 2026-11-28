import type { z } from 'zod'
import type { Repo } from '../../../../shared/repository/repo-types'
import { listGiteaPullRequestFiles } from '../../../gitea/pull-request-files'
import { getRepoRoutingConnectionId } from '../../../../shared/execution-host/execution-host'
import type {
  GiteaAddIssueComment,
  GiteaAddPullRequestReviewComment,
  GiteaCreateIssue,
  GiteaIssueByNumber,
  GiteaMergePullRequest,
  GiteaPullRequestChecks,
  GiteaPullRequestFileContents,
  GiteaUpdateIssue,
  GiteaWorkItemsList
} from '../../../../shared/rpc-contract/source-control/gitea-params'
import {
  addGiteaIssueComment,
  createGiteaIssue,
  getGiteaIssue,
  listGiteaAssignees,
  listGiteaIssueComments,
  listGiteaLabels,
  listGiteaWorkItems,
  updateGiteaIssue
} from '../../../gitea/issues/gitea-issues'
import {
  addGiteaPullRequestReviewComment,
  getGiteaPullRequestChecks,
  getGiteaPullRequestDetail,
  getGiteaPullRequestFileContents,
  listGiteaPullRequestReviewComments,
  mergeGiteaPullRequest
} from '../../../gitea/pull-request-review-operations'
import type { GiteaRepoTarget } from '../../../gitea/requests/gitea-repo-target'

type LocalGitArgs = [] | [{ wslDistro?: string }]

export type RuntimeGiteaCommandsDeps = {
  resolveRepo: (selector: string) => Promise<Repo>
  getLocalGitArgs: (repo: Repo) => LocalGitArgs
}

/** Repo-scoped Gitea reads and writes served by the host that owns the repository. */
export class RuntimeGiteaCommands {
  constructor(private readonly deps: RuntimeGiteaCommandsDeps) {}

  private async target(selector: string): Promise<GiteaRepoTarget> {
    const repo = await this.deps.resolveRepo(selector)
    return {
      repoPath: repo.path,
      connectionId: getRepoRoutingConnectionId(repo),
      localGitOptions: this.deps.getLocalGitArgs(repo)[0]
    }
  }

  async listGiteaRepoWorkItems(params: z.infer<typeof GiteaWorkItemsList>) {
    return listGiteaWorkItems(
      await this.target(params.repo),
      params.filter,
      params.limit,
      params.kind
    )
  }

  async getGiteaRepoIssue(params: z.infer<typeof GiteaIssueByNumber>) {
    return getGiteaIssue(await this.target(params.repo), params.number)
  }

  async listGiteaRepoIssueComments(params: z.infer<typeof GiteaIssueByNumber>) {
    return listGiteaIssueComments(await this.target(params.repo), params.number)
  }

  async listGiteaRepoLabels(repoSelector: string) {
    return listGiteaLabels(await this.target(repoSelector))
  }

  async listGiteaRepoAssignees(repoSelector: string) {
    return listGiteaAssignees(await this.target(repoSelector))
  }

  async createGiteaRepoIssue(params: z.infer<typeof GiteaCreateIssue>) {
    return createGiteaIssue(await this.target(params.repo), {
      title: params.title,
      body: params.body,
      assignees: params.assignees,
      labelIds: params.labelIds
    })
  }

  async updateGiteaRepoIssue(params: z.infer<typeof GiteaUpdateIssue>) {
    return updateGiteaIssue(await this.target(params.repo), params.number, params.updates)
  }

  async addGiteaRepoIssueComment(params: z.infer<typeof GiteaAddIssueComment>) {
    return addGiteaIssueComment(await this.target(params.repo), params.number, params.body)
  }

  async getGiteaRepoPullRequestDetail(params: z.infer<typeof GiteaIssueByNumber>) {
    return getGiteaPullRequestDetail(await this.target(params.repo), params.number)
  }

  async listGiteaRepoPullRequestFiles(params: z.infer<typeof GiteaIssueByNumber>) {
    return listGiteaPullRequestFiles(await this.target(params.repo), params.number)
  }

  async getGiteaRepoPullRequestFileContents(params: z.infer<typeof GiteaPullRequestFileContents>) {
    return getGiteaPullRequestFileContents(await this.target(params.repo), {
      path: params.path,
      oldPath: params.oldPath,
      status: params.status,
      baseSha: params.baseSha,
      headSha: params.headSha
    })
  }

  async getGiteaRepoPullRequestChecks(params: z.infer<typeof GiteaPullRequestChecks>) {
    return getGiteaPullRequestChecks(await this.target(params.repo), params.headSha)
  }

  async mergeGiteaRepoPullRequest(params: z.infer<typeof GiteaMergePullRequest>) {
    return mergeGiteaPullRequest(await this.target(params.repo), params.number, params.method)
  }

  async listGiteaRepoPullRequestReviewComments(params: z.infer<typeof GiteaIssueByNumber>) {
    return listGiteaPullRequestReviewComments(await this.target(params.repo), params.number)
  }

  async addGiteaRepoPullRequestReviewComment(
    params: z.infer<typeof GiteaAddPullRequestReviewComment>
  ) {
    return addGiteaPullRequestReviewComment(await this.target(params.repo), params.number, {
      path: params.path,
      line: params.line,
      body: params.body
    })
  }
}
