import { ipcRenderer } from 'electron'
import type { TaskSourceContext } from '../shared/task-source-context'

type GiteaRepoSelectorArgs = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
  repoOwnerExecutionHostId?: string
}

export const giteaApi = {
  viewer: () => ipcRenderer.invoke('gitea:viewer'),
  diagnoseAuth: () => ipcRenderer.invoke('gitea:diagnoseAuth'),
  rateLimit: (args?: { force?: boolean; host?: string | null }) =>
    ipcRenderer.invoke('gitea:rateLimit', args),
  projectSlug: (args: GiteaRepoSelectorArgs) => ipcRenderer.invoke('gitea:projectSlug', args),
  prForBranch: (args: GiteaRepoSelectorArgs & { branch: string; linkedPRNumber?: number | null }) =>
    ipcRenderer.invoke('gitea:prForBranch', args),
  pr: (args: GiteaRepoSelectorArgs & { number: number }) => ipcRenderer.invoke('gitea:pr', args),
  listPRs: (
    args: GiteaRepoSelectorArgs & {
      state?: 'opened' | 'closed' | 'merged' | 'all'
      page?: number
      perPage?: number
      query?: string
    }
  ) => ipcRenderer.invoke('gitea:listPRs', args),
  listWorkItems: (
    args: GiteaRepoSelectorArgs & {
      state?: 'opened' | 'closed' | 'merged' | 'all'
      page?: number
      perPage?: number
      query?: string
    }
  ) => ipcRenderer.invoke('gitea:listWorkItems', args),
  issue: (args: GiteaRepoSelectorArgs & { number: number }) =>
    ipcRenderer.invoke('gitea:issue', args),
  listIssues: (
    args: GiteaRepoSelectorArgs & {
      state?: 'opened' | 'closed' | 'all'
      assignee?: string
      limit?: number
      page?: number
    }
  ) => ipcRenderer.invoke('gitea:listIssues', args),
  createIssue: (args: GiteaRepoSelectorArgs & { title: string; body: string }) =>
    ipcRenderer.invoke('gitea:createIssue', args),
  updateIssue: (args: GiteaRepoSelectorArgs & { number: number; updates: unknown }) =>
    ipcRenderer.invoke('gitea:updateIssue', args),
  addIssueComment: (args: GiteaRepoSelectorArgs & { number: number; body: string }) =>
    ipcRenderer.invoke('gitea:addIssueComment', args),
  listLabels: (args: GiteaRepoSelectorArgs) => ipcRenderer.invoke('gitea:listLabels', args),
  listAssignableUsers: (args: GiteaRepoSelectorArgs) =>
    ipcRenderer.invoke('gitea:listAssignableUsers', args),
  notifications: (args: GiteaRepoSelectorArgs) => ipcRenderer.invoke('gitea:notifications', args),
  markNotificationRead: (args: GiteaRepoSelectorArgs & { notificationId: number }) =>
    ipcRenderer.invoke('gitea:markNotificationRead', args),
  workItemDetails: (
    args: GiteaRepoSelectorArgs & {
      number: number
      type: 'issue' | 'pr'
      includeReviewDetails?: boolean
      background?: boolean
    }
  ) => ipcRenderer.invoke('gitea:workItemDetails', args),
  closePR: (args: GiteaRepoSelectorArgs & { number: number }) =>
    ipcRenderer.invoke('gitea:closePR', args),
  reopenPR: (args: GiteaRepoSelectorArgs & { number: number }) =>
    ipcRenderer.invoke('gitea:reopenPR', args),
  mergePR: (
    args: GiteaRepoSelectorArgs & {
      number: number
      method?: 'merge' | 'squash' | 'rebase' | 'rebase-merge'
    }
  ) => ipcRenderer.invoke('gitea:mergePR', args),
  updatePR: (args: GiteaRepoSelectorArgs & { number: number; updates: unknown }) =>
    ipcRenderer.invoke('gitea:updatePR', args),
  updatePRReviewers: (
    args: GiteaRepoSelectorArgs & { number: number; reviewerUsernames: string[] }
  ) => ipcRenderer.invoke('gitea:updatePRReviewers', args),
  addPRComment: (args: GiteaRepoSelectorArgs & { number: number; body: string }) =>
    ipcRenderer.invoke('gitea:addPRComment', args),
  addPRInlineComment: (args: GiteaRepoSelectorArgs & { number: number; input: unknown }) =>
    ipcRenderer.invoke('gitea:addPRInlineComment', args),
  resolvePRDiscussion: (
    args: GiteaRepoSelectorArgs & { number: number; discussionId: string; resolved: boolean }
  ) => ipcRenderer.invoke('gitea:resolvePRDiscussion', args),
  submitPRReview: (
    args: GiteaRepoSelectorArgs & {
      number: number
      decision: 'approve' | 'request_changes'
      body?: string
    }
  ) => ipcRenderer.invoke('gitea:submitPRReview', args),
  jobTrace: (args: GiteaRepoSelectorArgs & { jobId: number; logExcerpt?: boolean }) =>
    ipcRenderer.invoke('gitea:jobTrace', args),
  workItemByPath: (
    args: GiteaRepoSelectorArgs & {
      host: string
      path: string
      number: number
      type: 'issue' | 'pr'
    }
  ) => ipcRenderer.invoke('gitea:workItemByPath', args)
}
