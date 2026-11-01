import type { GitLabProjectRef, GitLabWorkItem, MRListState } from '../../shared/gitlab-types'
import type { Repo } from '../../shared/repo-types'
import {
  diagnoseAuth,
  getRateLimit,
  getWorkItemByProjectRef,
  listAssignableUsers,
  listIssues,
  listLabels,
  listMergeRequests,
  listTodos,
  listWorkItems
} from '../gitlab/client'
import {
  normalizeGitLabIssueListArgs,
  normalizeGitLabMRListState,
  normalizeGitLabPositiveInteger,
  type GitLabIssueListState
} from '../gitlab/gitlab-preload-args'
import { getWorkItemDetails } from '../gitlab/work-item-details'
import { getRepoRoutingConnectionId } from '../../shared/execution-host'

type LocalGitArgs = [] | [{ wslDistro?: string }]

export type RuntimeGitLabQueryCommandsDeps = {
  resolveRepo: (selector: string) => Promise<Repo>
  getLocalGitArgs: (repo: Repo) => LocalGitArgs
  recordProjectRecent: (projectRef: GitLabProjectRef) => void
}

export class RuntimeGitLabQueryCommands {
  constructor(private readonly deps: RuntimeGitLabQueryCommandsDeps) {}

  async listGitLabRepoWorkItems(
    repoSelector: string,
    state?: MRListState,
    page?: number,
    perPage?: number,
    query?: string
  ): Promise<Awaited<ReturnType<typeof listWorkItems>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return listWorkItems(
      repo.path,
      state ?? 'opened',
      page ?? 1,
      perPage ?? 20,
      repo.issueSourcePreference,
      query,
      getRepoRoutingConnectionId(repo),
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async listGitLabRepoMRs(
    repoSelector: string,
    state?: MRListState,
    page?: number,
    perPage?: number,
    query?: string
  ): Promise<Awaited<ReturnType<typeof listMergeRequests>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return listMergeRequests(
      repo.path,
      normalizeGitLabMRListState(state),
      normalizeGitLabPositiveInteger(page, 1, 10_000),
      normalizeGitLabPositiveInteger(perPage, 20, 100),
      repo.issueSourcePreference,
      query,
      getRepoRoutingConnectionId(repo),
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async listGitLabRepoIssues(
    repoSelector: string,
    state?: GitLabIssueListState,
    assignee?: string,
    limit?: number,
    page?: number
  ): Promise<{
    items: GitLabWorkItem[]
    totalPages: number
    error?: Awaited<ReturnType<typeof listIssues>>['error']
  }> {
    const repo = await this.deps.resolveRepo(repoSelector)
    const normalized = normalizeGitLabIssueListArgs({ state, assignee, limit, page })
    // Keep page after localGitOptions; spreading optional args before it shifts positions (#13538).
    const result = await listIssues(
      repo.path,
      normalized.limit,
      repo.issueSourcePreference,
      normalized.state,
      normalized.assignee,
      getRepoRoutingConnectionId(repo),
      this.deps.getLocalGitArgs(repo)[0] ?? {},
      normalized.page
    )
    // Match TaskPage's desktop preload contract on web runtime.
    const items: GitLabWorkItem[] = result.items.map((issue) => ({
      id: `gitlab-issue-${repo.id}-${issue.number}`,
      type: 'issue' as const,
      number: issue.number,
      title: issue.title,
      state: issue.state,
      url: issue.url,
      labels: issue.labels,
      updatedAt: issue.updatedAt ?? '',
      author: issue.author ?? null,
      repoId: repo.id
    }))
    return {
      items,
      totalPages: result.totalPages,
      ...(result.error ? { error: result.error } : {})
    }
  }

  async listGitLabRepoTodos(repoSelector: string): Promise<Awaited<ReturnType<typeof listTodos>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return listTodos(
      repo.path,
      getRepoRoutingConnectionId(repo),
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  diagnoseGitLabAuth(): Promise<Awaited<ReturnType<typeof diagnoseAuth>>> {
    return diagnoseAuth()
  }

  getGitLabRateLimit(options?: {
    force?: boolean
    host?: string | null
  }): Promise<Awaited<ReturnType<typeof getRateLimit>>> {
    return getRateLimit(options)
  }

  async listGitLabRepoLabels(
    repoSelector: string
  ): Promise<Awaited<ReturnType<typeof listLabels>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return listLabels(
      repo.path,
      repo.issueSourcePreference,
      getRepoRoutingConnectionId(repo),
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async listGitLabRepoAssignableUsers(
    repoSelector: string
  ): Promise<Awaited<ReturnType<typeof listAssignableUsers>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return listAssignableUsers(
      repo.path,
      repo.issueSourcePreference,
      getRepoRoutingConnectionId(repo),
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async getGitLabRepoWorkItemDetails(
    repoSelector: string,
    iid: number,
    type: 'issue' | 'mr',
    projectRef?: GitLabProjectRef | null,
    includeReviewDetails?: boolean
  ): Promise<Awaited<ReturnType<typeof getWorkItemDetails>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return getWorkItemDetails(
      repo.path,
      iid,
      type,
      repo.issueSourcePreference,
      getRepoRoutingConnectionId(repo),
      projectRef,
      this.deps.getLocalGitArgs(repo)[0] ?? {},
      { includeReviewDetails }
    )
  }

  async getGitLabRepoWorkItemByPath(
    repoSelector: string,
    projectRef: GitLabProjectRef,
    iid: number,
    type: 'issue' | 'mr'
  ): Promise<Awaited<ReturnType<typeof getWorkItemByProjectRef>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    const result = await getWorkItemByProjectRef(
      repo.path,
      projectRef,
      iid,
      type,
      getRepoRoutingConnectionId(repo),
      ...this.deps.getLocalGitArgs(repo)
    )
    // Successful pasted-URL lookups must update recents as desktop IPC does.
    if (result) {
      this.deps.recordProjectRecent(projectRef)
    }
    return result
  }
}
