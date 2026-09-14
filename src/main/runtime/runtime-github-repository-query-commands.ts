import type { ListWorkItemsResult } from '../../shared/github/work-item-types'
import type { Repo } from '../../shared/repo-types'
import {
  countWorkItems,
  getWorkItem,
  getWorkItemByOwnerRepo,
  listAssignableUsers,
  listIssues,
  listLabels,
  listWorkItems,
  type MainWorkItem
} from '../github/client'
import { getRateLimit } from '../github/rate-limit'
import { getWorkItemDetails } from '../github/work-item-details'

type LocalGitArgs = [] | [{ wslDistro?: string }]

type RuntimeGitHubRepositoryQueryCommandsDeps = {
  resolveRepo: (selector: string) => Promise<Repo>
  getLocalGitArgs: (repo: Repo) => LocalGitArgs
}

export class RuntimeGitHubRepositoryQueryCommands {
  constructor(private readonly deps: RuntimeGitHubRepositoryQueryCommandsDeps) {}

  async listRepoWorkItems(
    repoSelector: string,
    limit?: number,
    query?: string,
    page?: number,
    noCache?: boolean
  ): Promise<ListWorkItemsResult<MainWorkItem>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return listWorkItems(
      repo.path,
      limit,
      query,
      page,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      noCache,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async listRepoIssues(
    repoSelector: string,
    limit?: number
  ): Promise<Awaited<ReturnType<typeof listIssues>>['items']> {
    const repo = await this.deps.resolveRepo(repoSelector)
    const result = await listIssues(
      repo.path,
      limit,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
    return result.items
  }

  async getRepoWorkItem(
    repoSelector: string,
    number: number,
    type?: 'issue' | 'pr'
  ): Promise<Awaited<ReturnType<typeof getWorkItem>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return getWorkItem(
      repo.path,
      number,
      type,
      repo.connectionId ?? null,
      this.deps.getLocalGitArgs(repo)[0] ?? {},
      repo.issueSourcePreference
    )
  }

  async getRepoWorkItemByOwnerRepo(
    repoSelector: string,
    ownerRepo: { owner: string; repo: string; host?: string },
    number: number,
    type: 'issue' | 'pr'
  ): Promise<Awaited<ReturnType<typeof getWorkItemByOwnerRepo>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return getWorkItemByOwnerRepo(
      repo.path,
      ownerRepo,
      number,
      type,
      repo.connectionId ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async getRepoWorkItemDetails(
    repoSelector: string,
    number: number,
    type?: 'issue' | 'pr'
  ): Promise<Awaited<ReturnType<typeof getWorkItemDetails>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return getWorkItemDetails(
      repo.path,
      number,
      type,
      repo.connectionId ?? null,
      this.deps.getLocalGitArgs(repo)[0] ?? {},
      repo.issueSourcePreference
    )
  }

  async countRepoWorkItems(repoSelector: string, query?: string): Promise<number> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return countWorkItems(
      repo.path,
      query,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async listRepoLabels(repoSelector: string): Promise<Awaited<ReturnType<typeof listLabels>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return listLabels(
      repo.path,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async listRepoAssignableUsers(
    repoSelector: string
  ): Promise<Awaited<ReturnType<typeof listAssignableUsers>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return listAssignableUsers(
      repo.path,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  getGitHubRateLimit(options?: {
    force?: boolean
  }): Promise<Awaited<ReturnType<typeof getRateLimit>>> {
    return getRateLimit(options)
  }
}
