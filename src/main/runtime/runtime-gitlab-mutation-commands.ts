import type {
  GitLabIssueUpdate,
  GitLabMRInlineCommentInput,
  GitLabMRUpdate,
  GitLabProjectRef
} from '../../shared/gitlab-types'
import type { Repo } from '../../shared/repo-types'
import {
  addIssueComment,
  addMRComment,
  addMRInlineComment,
  closeMR,
  createIssue,
  getJobTrace,
  mergeMR,
  reopenMR,
  resolveMRDiscussion,
  retryJob,
  updateIssue,
  updateMR,
  updateMRReviewers
} from '../gitlab/client'

type LocalGitArgs = [] | [{ wslDistro?: string }]

export class RuntimeGitLabMutationCommands {
  constructor(
    private readonly deps: {
      resolveRepo: (selector: string) => Promise<Repo>
      getLocalGitArgs: (repo: Repo) => LocalGitArgs
    }
  ) {}

  async createGitLabRepoIssue(repoSelector: string, title: string, body: string) {
    const repo = await this.deps.resolveRepo(repoSelector)
    return createIssue(
      repo.path,
      title,
      body,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async updateGitLabRepoIssue(
    repoSelector: string,
    number: number,
    updates: GitLabIssueUpdate,
    projectRef?: GitLabProjectRef | null
  ) {
    const repo = await this.deps.resolveRepo(repoSelector)
    return updateIssue(
      repo.path,
      number,
      updates,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      projectRef,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async addGitLabRepoIssueComment(
    repoSelector: string,
    number: number,
    body: string,
    projectRef?: GitLabProjectRef | null
  ) {
    const repo = await this.deps.resolveRepo(repoSelector)
    return addIssueComment(
      repo.path,
      number,
      body,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      projectRef,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async addGitLabRepoMRComment(
    repoSelector: string,
    iid: number,
    body: string,
    projectRef?: GitLabProjectRef | null
  ) {
    const repo = await this.deps.resolveRepo(repoSelector)
    return addMRComment(
      repo.path,
      iid,
      body,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      projectRef,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async addGitLabRepoMRInlineComment(
    repoSelector: string,
    iid: number,
    input: GitLabMRInlineCommentInput,
    projectRef?: GitLabProjectRef | null
  ) {
    const repo = await this.deps.resolveRepo(repoSelector)
    return addMRInlineComment(
      repo.path,
      iid,
      input,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      projectRef,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async resolveGitLabRepoMRDiscussion(
    repoSelector: string,
    iid: number,
    discussionId: string,
    resolved: boolean,
    projectRef?: GitLabProjectRef | null
  ) {
    const repo = await this.deps.resolveRepo(repoSelector)
    return resolveMRDiscussion(
      repo.path,
      iid,
      discussionId,
      resolved,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      projectRef,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async getGitLabRepoJobTrace(
    repoSelector: string,
    jobId: number,
    projectRef?: GitLabProjectRef | null
  ) {
    const repo = await this.deps.resolveRepo(repoSelector)
    return getJobTrace(
      repo.path,
      jobId,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      projectRef,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async retryGitLabRepoJob(
    repoSelector: string,
    jobId: number,
    projectRef?: GitLabProjectRef | null
  ) {
    const repo = await this.deps.resolveRepo(repoSelector)
    return retryJob(
      repo.path,
      jobId,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      projectRef,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async mergeGitLabRepoMR(
    repoSelector: string,
    iid: number,
    method?: 'merge' | 'squash' | 'rebase',
    projectRef?: GitLabProjectRef | null
  ) {
    const repo = await this.deps.resolveRepo(repoSelector)
    return mergeMR(
      repo.path,
      iid,
      method ?? 'merge',
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      projectRef,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async updateGitLabRepoMRState(
    repoSelector: string,
    iid: number,
    state: 'opened' | 'closed',
    projectRef?: GitLabProjectRef | null
  ) {
    const repo = await this.deps.resolveRepo(repoSelector)
    const updateState = state === 'closed' ? closeMR : reopenMR
    return updateState(
      repo.path,
      iid,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      projectRef,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async updateGitLabRepoMR(
    repoSelector: string,
    iid: number,
    updates: GitLabMRUpdate,
    projectRef?: GitLabProjectRef | null
  ) {
    const repo = await this.deps.resolveRepo(repoSelector)
    return updateMR(
      repo.path,
      iid,
      updates,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      projectRef,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async updateGitLabRepoMRReviewers(
    repoSelector: string,
    iid: number,
    reviewerIds: number[],
    projectRef?: GitLabProjectRef | null
  ) {
    const repo = await this.deps.resolveRepo(repoSelector)
    return updateMRReviewers(
      repo.path,
      iid,
      reviewerIds,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      projectRef,
      ...this.deps.getLocalGitArgs(repo)
    )
  }
}
