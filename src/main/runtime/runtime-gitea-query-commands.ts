import type { GiteaProjectRef, PRListState } from '../../shared/gitea-types'
import {
  getGiteaPullRequest,
  getGiteaPullRequestForBranch,
  getGiteaRepoSlug
} from '../gitea/client'
import {
  diagnoseGiteaAuth,
  getAuthenticatedViewer,
  getRateLimit
} from '../gitea/gitea-auth-and-rate-limit'
import { getGiteaIssue, listGiteaIssues } from '../gitea/issues'
import { listGiteaNotifications, markGiteaNotificationRead } from '../gitea/notifications'
import { listGiteaAssignableUsers, listGiteaLabels } from '../gitea/repo-label-and-assignee-lookup'
import { listGiteaPullRequests } from '../gitea/pull-request-list'
import { listGiteaWorkItems } from '../gitea/work-item-queries'
import { getGiteaWorkItemDetails } from '../gitea/work-item-details'
import { getRepoRoutingConnectionId } from '../../shared/execution-host'
import { RuntimeGiteaCommandBase } from './runtime-gitea-command-base'

export class RuntimeGiteaQueryCommands extends RuntimeGiteaCommandBase {
  diagnoseGiteaAuth() {
    return diagnoseGiteaAuth()
  }

  getGiteaViewer() {
    return getAuthenticatedViewer()
  }

  getGiteaRateLimit(options?: { force?: boolean; host?: string | null }) {
    return getRateLimit({ force: Boolean(options?.force), host: options?.host ?? null })
  }

  async getGiteaProjectRef(repoSelector: string) {
    const repo = await this.repo(repoSelector)
    const resolved = await getGiteaRepoSlug(
      repo.path,
      getRepoRoutingConnectionId(repo),
      this.reviewOptions(repo)
    )
    return resolved ? { host: resolved.host, path: `${resolved.owner}/${resolved.repo}` } : null
  }

  async getGiteaPullRequestForBranch(
    repoSelector: string,
    branch: string,
    linkedPRNumber?: number | null
  ) {
    const repo = await this.repo(repoSelector)
    return getGiteaPullRequestForBranch(
      repo.path,
      branch,
      linkedPRNumber ?? null,
      getRepoRoutingConnectionId(repo),
      this.reviewOptions(repo)
    )
  }

  async getGiteaPullRequestByNumber(repoSelector: string, number: number) {
    const repo = await this.repo(repoSelector)
    return getGiteaPullRequest(
      repo.path,
      number,
      getRepoRoutingConnectionId(repo),
      this.reviewOptions(repo)
    )
  }

  async listGiteaRepoPRs(
    repoSelector: string,
    state?: PRListState,
    page?: number,
    perPage?: number,
    query?: string
  ) {
    const repo = await this.repo(repoSelector)
    return listGiteaPullRequests(
      repo.path,
      state ?? 'opened',
      page ?? 1,
      perPage ?? 20,
      repo.issueSourcePreference,
      query,
      getRepoRoutingConnectionId(repo),
      this.gitOptions(repo)
    )
  }

  async listGiteaRepoWorkItems(
    repoSelector: string,
    state?: PRListState,
    page?: number,
    perPage?: number,
    query?: string
  ) {
    const repo = await this.repo(repoSelector)
    return listGiteaWorkItems(
      repo.path,
      state ?? 'opened',
      page ?? 1,
      perPage ?? 20,
      repo.issueSourcePreference,
      query,
      getRepoRoutingConnectionId(repo),
      this.gitOptions(repo)
    )
  }

  async getGiteaRepoIssue(repoSelector: string, number: number) {
    const repo = await this.repo(repoSelector)
    return getGiteaIssue(repo.path, number, getRepoRoutingConnectionId(repo), this.gitOptions(repo))
  }

  async listGiteaRepoIssues(
    repoSelector: string,
    state?: 'opened' | 'closed' | 'all',
    assignee?: string,
    limit?: number,
    page?: number
  ) {
    const repo = await this.repo(repoSelector)
    return listGiteaIssues(
      repo.path,
      limit ?? 20,
      repo.issueSourcePreference,
      state ?? 'opened',
      assignee,
      getRepoRoutingConnectionId(repo),
      this.gitOptions(repo),
      page ?? 1
    )
  }

  async listGiteaRepoLabels(repoSelector: string) {
    const repo = await this.repo(repoSelector)
    return listGiteaLabels(
      repo.path,
      repo.issueSourcePreference,
      getRepoRoutingConnectionId(repo),
      this.gitOptions(repo)
    )
  }

  async listGiteaRepoAssignableUsers(repoSelector: string) {
    const repo = await this.repo(repoSelector)
    return listGiteaAssignableUsers(
      repo.path,
      repo.issueSourcePreference,
      getRepoRoutingConnectionId(repo),
      this.gitOptions(repo)
    )
  }

  async listGiteaRepoNotifications(repoSelector: string) {
    const repo = await this.repo(repoSelector)
    return listGiteaNotifications(
      repo.path,
      getRepoRoutingConnectionId(repo),
      this.gitOptions(repo)
    )
  }

  async markGiteaRepoNotificationRead(repoSelector: string, notificationId: number) {
    const repo = await this.repo(repoSelector)
    return markGiteaNotificationRead(
      repo.path,
      notificationId,
      getRepoRoutingConnectionId(repo),
      this.gitOptions(repo)
    )
  }

  async getGiteaRepoWorkItemDetails(
    repoSelector: string,
    number: number,
    type: 'issue' | 'pr',
    projectRef?: GiteaProjectRef | null,
    includeReviewDetails?: boolean
  ) {
    const repo = await this.repo(repoSelector)
    return getGiteaWorkItemDetails(
      repo.path,
      number,
      type,
      repo.issueSourcePreference,
      getRepoRoutingConnectionId(repo),
      projectRef,
      this.gitOptions(repo),
      { includeReviewDetails }
    )
  }
}
