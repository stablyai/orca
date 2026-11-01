import type {
  GiteaIssueUpdate,
  GiteaMergeStyle,
  GiteaPRInlineCommentInput,
  GiteaPRUpdate,
  GiteaProjectRef,
  GiteaReviewDecision
} from '../../shared/gitea-types'
import { getRepoRoutingConnectionId } from '../../shared/execution-host'
import { getGiteaJobTrace } from '../gitea/actions-job-logs'
import { addGiteaIssueComment, createGiteaIssue } from '../gitea/issue-create'
import { updateGiteaIssue } from '../gitea/issue-update'
import { addGiteaPRComment, addGiteaPRInlineComment } from '../gitea/pull-request-review-comments'
import {
  resolveGiteaPRDiscussion,
  submitGiteaPRReview
} from '../gitea/pull-request-review-mutations'
import { updateGiteaPRReviewers } from '../gitea/pull-request-reviewer-update'
import { closeGiteaPR, mergeGiteaPR, reopenGiteaPR } from '../gitea/pull-request-state-mutations'
import { updateGiteaPR } from '../gitea/pull-request-update'
import { getGiteaWorkItemByPath } from '../gitea/work-item-queries'
import { RuntimeGiteaCommandBase } from './runtime-gitea-command-base'

export class RuntimeGiteaMutationCommands extends RuntimeGiteaCommandBase {
  async createGiteaRepoIssue(repoSelector: string, title: string, body: string) {
    const repo = await this.repo(repoSelector)
    return createGiteaIssue(
      repo.path,
      title,
      body,
      repo.issueSourcePreference,
      getRepoRoutingConnectionId(repo),
      this.gitOptions(repo)
    )
  }

  async updateGiteaRepoIssue(
    repoSelector: string,
    number: number,
    updates: GiteaIssueUpdate,
    projectRef?: GiteaProjectRef | null
  ) {
    const repo = await this.repo(repoSelector)
    return updateGiteaIssue(
      repo.path,
      number,
      updates,
      repo.issueSourcePreference,
      getRepoRoutingConnectionId(repo),
      projectRef,
      this.gitOptions(repo)
    )
  }

  async addGiteaRepoIssueComment(
    repoSelector: string,
    number: number,
    body: string,
    projectRef?: GiteaProjectRef | null
  ) {
    const repo = await this.repo(repoSelector)
    return addGiteaIssueComment(
      repo.path,
      number,
      body,
      repo.issueSourcePreference,
      getRepoRoutingConnectionId(repo),
      projectRef,
      this.gitOptions(repo)
    )
  }

  async updateGiteaRepoPRState(
    repoSelector: string,
    number: number,
    state: 'open' | 'closed',
    projectRef?: GiteaProjectRef | null
  ) {
    const repo = await this.repo(repoSelector)
    const change = state === 'closed' ? closeGiteaPR : reopenGiteaPR
    return change(
      repo.path,
      number,
      repo.issueSourcePreference,
      getRepoRoutingConnectionId(repo),
      projectRef,
      this.gitOptions(repo)
    )
  }

  async mergeGiteaRepoPR(
    repoSelector: string,
    number: number,
    method?: GiteaMergeStyle,
    projectRef?: GiteaProjectRef | null
  ) {
    const repo = await this.repo(repoSelector)
    return mergeGiteaPR(
      repo.path,
      number,
      method ?? 'merge',
      repo.issueSourcePreference,
      getRepoRoutingConnectionId(repo),
      projectRef,
      this.gitOptions(repo)
    )
  }

  async updateGiteaRepoPR(
    repoSelector: string,
    number: number,
    updates: GiteaPRUpdate,
    projectRef?: GiteaProjectRef | null
  ) {
    const repo = await this.repo(repoSelector)
    return updateGiteaPR(
      repo.path,
      number,
      updates,
      repo.issueSourcePreference,
      getRepoRoutingConnectionId(repo),
      projectRef,
      this.gitOptions(repo)
    )
  }

  async updateGiteaRepoPRReviewers(
    repoSelector: string,
    number: number,
    reviewerUsernames: string[],
    projectRef?: GiteaProjectRef | null
  ) {
    const repo = await this.repo(repoSelector)
    return updateGiteaPRReviewers(
      repo.path,
      number,
      reviewerUsernames,
      repo.issueSourcePreference,
      getRepoRoutingConnectionId(repo),
      projectRef,
      this.gitOptions(repo)
    )
  }

  async addGiteaRepoPRComment(
    repoSelector: string,
    number: number,
    body: string,
    projectRef?: GiteaProjectRef | null
  ) {
    const repo = await this.repo(repoSelector)
    return addGiteaPRComment(
      repo.path,
      number,
      body,
      repo.issueSourcePreference,
      getRepoRoutingConnectionId(repo),
      projectRef,
      this.gitOptions(repo)
    )
  }

  async addGiteaRepoPRInlineComment(
    repoSelector: string,
    number: number,
    input: GiteaPRInlineCommentInput,
    projectRef?: GiteaProjectRef | null
  ) {
    const repo = await this.repo(repoSelector)
    return addGiteaPRInlineComment(
      repo.path,
      number,
      input,
      repo.issueSourcePreference,
      getRepoRoutingConnectionId(repo),
      projectRef,
      this.gitOptions(repo)
    )
  }

  async resolveGiteaRepoPRDiscussion(
    repoSelector: string,
    number: number,
    discussionId: string,
    resolved: boolean,
    projectRef?: GiteaProjectRef | null
  ) {
    const repo = await this.repo(repoSelector)
    return resolveGiteaPRDiscussion(
      repo.path,
      number,
      discussionId,
      resolved,
      repo.issueSourcePreference,
      getRepoRoutingConnectionId(repo),
      projectRef,
      this.gitOptions(repo)
    )
  }

  async submitGiteaRepoPRReview(
    repoSelector: string,
    number: number,
    decision: GiteaReviewDecision,
    body?: string,
    projectRef?: GiteaProjectRef | null
  ) {
    const repo = await this.repo(repoSelector)
    return submitGiteaPRReview(
      repo.path,
      number,
      decision,
      body,
      repo.issueSourcePreference,
      getRepoRoutingConnectionId(repo),
      projectRef,
      this.gitOptions(repo)
    )
  }

  async getGiteaRepoJobTrace(
    repoSelector: string,
    jobId: number,
    projectRef?: GiteaProjectRef | null
  ) {
    const repo = await this.repo(repoSelector)
    return getGiteaJobTrace(
      repo.path,
      jobId,
      repo.issueSourcePreference,
      getRepoRoutingConnectionId(repo),
      projectRef,
      this.gitOptions(repo)
    )
  }

  async getGiteaRepoWorkItemByPath(
    repoSelector: string,
    project: GiteaProjectRef,
    number: number,
    type: 'issue' | 'pr'
  ) {
    const repo = await this.repo(repoSelector)
    const item = await getGiteaWorkItemByPath(
      repo.path,
      project,
      number,
      type,
      getRepoRoutingConnectionId(repo),
      this.gitOptions(repo)
    )
    if (!item) {
      return null
    }
    const { repoId, ...rest } = item
    void repoId
    return rest
  }
}
