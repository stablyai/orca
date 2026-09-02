import { ipcRenderer } from 'electron'
import type { GitHubReactionContent } from '../../shared/github/comment-types'
import type {
  GitHubPRRefreshCandidate,
  GitHubPRRefreshEvent,
  GitHubPRRefreshReason
} from '../../shared/github/pull-request-refresh-types'
import type { GitHubOwnerRepo } from '../../shared/github/pull-request-types'
import type { GitHubWorkItem, ListWorkItemsResult } from '../../shared/github/work-item-types'
import type { GitHubCreateIssueResult } from '../../shared/issue-mutation-types'
import type { TaskSourceContext } from '../../shared/task-source-context'
import type { PreloadApi } from '../api-types'

export const ghPullRequestsAndWorkItemsApi = {
  viewer: () => ipcRenderer.invoke('gh:viewer'),
  repoSlug: (args: { repoPath: string; repoId?: string }) =>
    ipcRenderer.invoke('gh:repoSlug', args),
  repoUpstream: (args: { repoPath: string; repoId?: string }) =>
    ipcRenderer.invoke('gh:repoUpstream', args),
  prForBranch: (args: {
    repoPath: string
    repoId?: string | null
    branch: string
    linkedPRNumber?: number | null
    fallbackPRNumber?: number | null
    acceptMergedFallbackPR?: boolean
    currentHeadOid?: string | null
  }) => ipcRenderer.invoke('gh:prForBranch', args),
  refreshPRNow: (args: { candidate: GitHubPRRefreshCandidate }) =>
    ipcRenderer.invoke('gh:refreshPRNow', args),
  enqueuePRRefresh: (args: {
    candidate: GitHubPRRefreshCandidate
    reason: GitHubPRRefreshReason
    priority?: number
  }) => ipcRenderer.invoke('gh:enqueuePRRefresh', args),
  reportVisiblePRRefreshCandidates: (args: {
    candidates: GitHubPRRefreshCandidate[]
    generation: number
  }) => ipcRenderer.invoke('gh:reportVisiblePRRefreshCandidates', args),
  onPRRefreshEvent: (callback: (event: GitHubPRRefreshEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: GitHubPRRefreshEvent): void =>
      callback(event)
    ipcRenderer.on('gh:prRefreshEvent', listener)
    return () => ipcRenderer.removeListener('gh:prRefreshEvent', listener)
  },
  issue: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    number: number
  }) => ipcRenderer.invoke('gh:issue', args),
  workItem: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    number: number
    type?: 'issue' | 'pr'
  }) => ipcRenderer.invoke('gh:workItem', args),
  workItemByOwnerRepo: (args: {
    repoPath: string
    repoId?: string | null
    owner: string
    repo: string
    host?: string
    number: number
    type: 'issue' | 'pr'
  }) => ipcRenderer.invoke('gh:workItemByOwnerRepo', args),
  workItemDetails: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    number: number
    type?: 'issue' | 'pr'
  }) => ipcRenderer.invoke('gh:workItemDetails', args),
  notifyWorkItemMutated: (args: {
    repoPath: string
    repoId?: string | null
    type: 'issue' | 'pr'
    number: number
  }): Promise<boolean> => ipcRenderer.invoke('gh:notifyWorkItemMutated', args),
  prFileContents: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    prNumber: number
    prRepo?: GitHubOwnerRepo | null
    path: string
    oldPath?: string
    status: string
    headSha: string
    baseSha: string
  }) => ipcRenderer.invoke('gh:prFileContents', args),
  listIssues: (args: { repoPath: string; repoId?: string; limit?: number }) =>
    ipcRenderer.invoke('gh:listIssues', args),
  createIssue: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    title: string
    body: string
    labels?: string[]
    assignees?: string[]
  }): Promise<GitHubCreateIssueResult> => ipcRenderer.invoke('gh:createIssue', args),
  countWorkItems: (args: { repoPath: string; repoId?: string; query?: string }): Promise<number> =>
    ipcRenderer.invoke('gh:countWorkItems', args),
  listWorkItems: (args: {
    repoPath: string
    repoId?: string | null
    limit?: number
    query?: string
    page?: number
    noCache?: boolean
  }): Promise<ListWorkItemsResult<Omit<GitHubWorkItem, 'repoId'>>> =>
    ipcRenderer.invoke('gh:listWorkItems', args),
  prChecks: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    prNumber: number
    headSha?: string
    prRepo?: GitHubOwnerRepo | null
    noCache?: boolean
  }) => ipcRenderer.invoke('gh:prChecks', args),
  prCheckDetails: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    checkRunId?: number
    workflowRunId?: number
    checkName?: string
    url?: string | null
    prRepo?: GitHubOwnerRepo | null
  }) => ipcRenderer.invoke('gh:prCheckDetails', args),
  rerunPRChecks: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    prNumber: number
    headSha?: string
    failedOnly?: boolean
    prRepo?: GitHubOwnerRepo | null
  }): Promise<{ ok: true; count: number } | { ok: false; error: string }> =>
    ipcRenderer.invoke('gh:rerunPRChecks', args),
  prComments: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    prNumber: number
    prRepo?: GitHubOwnerRepo | null
    noCache?: boolean
  }) => ipcRenderer.invoke('gh:prComments', args),
  setPRCommentReaction: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    reactionSubjectId: string
    content: GitHubReactionContent
    reacted: boolean
    prRepo?: GitHubOwnerRepo | null
  }): Promise<boolean> => ipcRenderer.invoke('gh:setPRCommentReaction', args),
  resolveReviewThread: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    threadId: string
    resolve: boolean
    prRepo?: GitHubOwnerRepo | null
  }): Promise<boolean> => ipcRenderer.invoke('gh:resolveReviewThread', args),
  setPRFileViewed: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    prNumber: number
    prRepo?: GitHubOwnerRepo | null
    pullRequestId: string
    path: string
    viewed: boolean
  }): Promise<boolean> => ipcRenderer.invoke('gh:setPRFileViewed', args),
  updatePRTitle: (args: {
    repoPath: string
    repoId?: string | null
    prNumber: number
    title: string
    prRepo?: GitHubOwnerRepo | null
  }): Promise<boolean> => ipcRenderer.invoke('gh:updatePRTitle', args),
  mergePR: (args: {
    repoPath: string
    repoId?: string | null
    sourceContext?: TaskSourceContext | null
    prNumber: number
    method?: 'merge' | 'squash' | 'rebase'
    prRepo?: GitHubOwnerRepo | null
  }): Promise<{ ok: true } | { ok: false; error: string }> => ipcRenderer.invoke('gh:mergePR', args)
} satisfies Partial<PreloadApi['gh']>
