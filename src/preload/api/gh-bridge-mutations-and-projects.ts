import { ipcRenderer } from 'electron'
import type { GitHubCommentResult } from '../../shared/github/comment-types'
import type { GitHubAssignableUser, GitHubOwnerRepo } from '../../shared/github/pull-request-types'
import type { GetRateLimitResult } from '../../shared/github/rate-limit-types'
import type { GhAuthDiagnostic } from '../../shared/github/auth-types'
import type { TaskSourceContext } from '../../shared/task-source-context'
import type {
  GetProjectViewTableResult,
  GitHubProjectCommentMutationResult,
  GitHubProjectMutationResult,
  ListAccessibleProjectsResult,
  ListAssignableUsersBySlugResult,
  ListIssueTypesBySlugResult,
  ListLabelsBySlugResult,
  ListProjectViewsResult,
  ProjectWorkItemDetailsBySlugResult,
  ResolveProjectRefResult
} from '../../shared/github/project-result-types'
import type {
  AddIssueCommentBySlugArgs,
  ClearProjectItemFieldArgs,
  DeleteIssueCommentBySlugArgs,
  GetProjectViewTableArgs,
  ListAccessibleProjectsArgs,
  ListAssignableUsersBySlugArgs,
  ListIssueTypesBySlugArgs,
  ListLabelsBySlugArgs,
  ListProjectViewsArgs,
  ProjectWorkItemDetailsBySlugArgs,
  ResolveProjectRefArgs,
  UpdateIssueBySlugArgs,
  UpdateIssueCommentBySlugArgs,
  UpdateIssueTypeBySlugArgs,
  UpdatePullRequestBySlugArgs,
  UpdateProjectItemFieldArgs
} from '../../shared/github/project-request-types'
import type { AppStarSource } from '../../shared/gh-star-source'
import type { PreloadApi } from '../api-types'

export const ghMutationsAndProjectsApi = {
  setPRAutoMerge: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    prNumber: number
    enabled: boolean
    method?: 'merge' | 'squash' | 'rebase'
    prRepo?: GitHubOwnerRepo | null
  }): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('gh:setPRAutoMerge', args),
  updatePRState: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    prNumber: number
    updates: { state: 'open' | 'closed' }
    prRepo?: GitHubOwnerRepo | null
  }): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('gh:updatePRState', args),
  markPRReadyForReview: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    prNumber: number
    prRepo?: GitHubOwnerRepo | null
  }): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('gh:markPRReadyForReview', args),
  requestPRReviewers: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    prNumber: number
    reviewers: string[]
    prRepo?: GitHubOwnerRepo | null
  }): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('gh:requestPRReviewers', args),
  removePRReviewers: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    prNumber: number
    reviewers: string[]
    prRepo?: GitHubOwnerRepo | null
  }): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('gh:removePRReviewers', args),
  updateIssue: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    number: number
    updates: unknown
  }): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('gh:updateIssue', args),
  addIssueComment: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    number: number
    body: string
    type?: 'issue' | 'pr'
    prRepo?: GitHubOwnerRepo | null
  }): Promise<GitHubCommentResult> => ipcRenderer.invoke('gh:addIssueComment', args),
  addPRReviewCommentReply: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    prNumber: number
    commentId: number
    body: string
    threadId?: string
    path?: string
    line?: number
    prRepo?: GitHubOwnerRepo | null
  }): Promise<GitHubCommentResult> => ipcRenderer.invoke('gh:addPRReviewCommentReply', args),
  addPRReviewComment: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    prNumber: number
    prRepo?: GitHubOwnerRepo | null
    commitId: string
    path: string
    line: number
    startLine?: number
    body: string
  }): Promise<GitHubCommentResult> => ipcRenderer.invoke('gh:addPRReviewComment', args),
  listLabels: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
  }): Promise<string[]> => ipcRenderer.invoke('gh:listLabels', args),
  listAssignableUsers: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
  }): Promise<GitHubAssignableUser[]> => ipcRenderer.invoke('gh:listAssignableUsers', args),
  onWorkItemMutated: (
    callback: (payload: {
      repoPath: string
      repoId?: string
      type: 'issue' | 'pr'
      number: number
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { repoPath: string; repoId?: string; type: 'issue' | 'pr'; number: number }
    ): void => callback(payload)
    ipcRenderer.on('gh:workItemMutated', listener)
    return () => ipcRenderer.removeListener('gh:workItemMutated', listener)
  },
  checkOrcaStarred: (): Promise<boolean | null> => ipcRenderer.invoke('gh:checkOrcaStarred'),
  starOrca: (source: AppStarSource): Promise<boolean> => ipcRenderer.invoke('gh:starOrca', source),
  rateLimit: (args?: { force?: boolean }): Promise<GetRateLimitResult> =>
    ipcRenderer.invoke('gh:rateLimit', args),
  diagnoseAuth: (args?: { host?: string }): Promise<GhAuthDiagnostic> =>
    ipcRenderer.invoke('gh:diagnoseAuth', args),
  listAccessibleProjects: (
    args?: ListAccessibleProjectsArgs
  ): Promise<ListAccessibleProjectsResult> => ipcRenderer.invoke('gh:listAccessibleProjects', args),
  resolveProjectRef: (args: ResolveProjectRefArgs): Promise<ResolveProjectRefResult> =>
    ipcRenderer.invoke('gh:resolveProjectRef', args),
  listProjectViews: (args: ListProjectViewsArgs): Promise<ListProjectViewsResult> =>
    ipcRenderer.invoke('gh:listProjectViews', args),
  getProjectViewTable: (args: GetProjectViewTableArgs): Promise<GetProjectViewTableResult> =>
    ipcRenderer.invoke('gh:getProjectViewTable', args),
  projectWorkItemDetailsBySlug: (
    args: ProjectWorkItemDetailsBySlugArgs
  ): Promise<ProjectWorkItemDetailsBySlugResult> =>
    ipcRenderer.invoke('gh:projectWorkItemDetailsBySlug', args),
  updateProjectItemField: (
    args: UpdateProjectItemFieldArgs
  ): Promise<GitHubProjectMutationResult> => ipcRenderer.invoke('gh:updateProjectItemField', args),
  clearProjectItemField: (args: ClearProjectItemFieldArgs): Promise<GitHubProjectMutationResult> =>
    ipcRenderer.invoke('gh:clearProjectItemField', args),
  updateIssueBySlug: (args: UpdateIssueBySlugArgs): Promise<GitHubProjectMutationResult> =>
    ipcRenderer.invoke('gh:updateIssueBySlug', args),
  updatePullRequestBySlug: (
    args: UpdatePullRequestBySlugArgs
  ): Promise<GitHubProjectMutationResult> => ipcRenderer.invoke('gh:updatePullRequestBySlug', args),
  addIssueCommentBySlug: (
    args: AddIssueCommentBySlugArgs
  ): Promise<GitHubProjectCommentMutationResult> =>
    ipcRenderer.invoke('gh:addIssueCommentBySlug', args),
  updateIssueCommentBySlug: (
    args: UpdateIssueCommentBySlugArgs
  ): Promise<GitHubProjectMutationResult> =>
    ipcRenderer.invoke('gh:updateIssueCommentBySlug', args),
  deleteIssueCommentBySlug: (
    args: DeleteIssueCommentBySlugArgs
  ): Promise<GitHubProjectMutationResult> =>
    ipcRenderer.invoke('gh:deleteIssueCommentBySlug', args),
  listLabelsBySlug: (args: ListLabelsBySlugArgs): Promise<ListLabelsBySlugResult> =>
    ipcRenderer.invoke('gh:listLabelsBySlug', args),
  listAssignableUsersBySlug: (
    args: ListAssignableUsersBySlugArgs
  ): Promise<ListAssignableUsersBySlugResult> =>
    ipcRenderer.invoke('gh:listAssignableUsersBySlug', args),
  listIssueTypesBySlug: (args: ListIssueTypesBySlugArgs): Promise<ListIssueTypesBySlugResult> =>
    ipcRenderer.invoke('gh:listIssueTypesBySlug', args),
  updateIssueTypeBySlug: (args: UpdateIssueTypeBySlugArgs): Promise<GitHubProjectMutationResult> =>
    ipcRenderer.invoke('gh:updateIssueTypeBySlug', args)
} satisfies Partial<PreloadApi['gh']>
