import { ipcMain } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'

const GITHUB_PROJECT_VIEW_CHANNELS = [
  'gh:listAccessibleProjects',
  'gh:resolveProjectRef',
  'gh:listProjectViews',
  'gh:getProjectViewTable',
  'gh:projectWorkItemDetailsBySlug',
  'gh:updateProjectItemField',
  'gh:clearProjectItemField',
  'gh:updateIssueBySlug',
  'gh:updatePullRequestBySlug',
  'gh:addIssueCommentBySlug',
  'gh:updateIssueCommentBySlug',
  'gh:deleteIssueCommentBySlug',
  'gh:listLabelsBySlug',
  'gh:listAssignableUsersBySlug',
  'gh:listIssueTypesBySlug',
  'gh:updateIssueTypeBySlug'
] as const

const GITHUB_PR_REVIEW_CHANNELS = [
  'gh:setPRFileViewed',
  'gh:addPRReviewCommentReply',
  'gh:addPRReviewComment'
] as const

const GITHUB_PR_MUTATION_CHANNELS = [
  'gh:updatePRTitle',
  'gh:mergePR',
  'gh:setPRAutoMerge',
  'gh:updatePRState',
  'gh:markPRReadyForReview',
  'gh:rerunPRChecks',
  'gh:requestPRReviewers',
  'gh:removePRReviewers'
] as const

const GITHUB_ISSUE_MUTATION_CHANNELS = [
  'gh:updateIssue',
  'gh:addIssueComment',
  'gh:listLabels',
  'gh:listAssignableUsers'
] as const

const GITHUB_ACCOUNT_CHANNELS = [
  'gh:viewer',
  'gh:checkOrcaStarred',
  'gh:starOrca',
  'gh:rateLimit',
  'gh:diagnoseAuth',
  'gh:listBindableAccounts',
  'gh:validateAccountBinding'
] as const

function clearChannels(channels: readonly string[]): void {
  for (const channel of channels) {
    ipcMain.removeHandler(channel)
  }
}

export function registerLazyGitHubSecondaryHandlers(store: Store): void {
  clearChannels(GITHUB_PROJECT_VIEW_CHANNELS)
  registerLazyIpcHandleGroup(GITHUB_PROJECT_VIEW_CHANNELS, async (ipc) => {
    const { registerGitHubProjectViewHandlers } = await import('./github-project-view-handlers')
    registerGitHubProjectViewHandlers(ipc)
  })

  clearChannels(GITHUB_PR_REVIEW_CHANNELS)
  registerLazyIpcHandleGroup(GITHUB_PR_REVIEW_CHANNELS, async (ipc) => {
    const { registerGitHubPRReviewHandlers } = await import('./github-pr-review-handlers')
    registerGitHubPRReviewHandlers(store, ipc)
  })

  clearChannels(GITHUB_PR_MUTATION_CHANNELS)
  registerLazyIpcHandleGroup(GITHUB_PR_MUTATION_CHANNELS, async (ipc) => {
    const { registerGitHubPRMutationHandlers } = await import('./github-pr-mutation-handlers')
    registerGitHubPRMutationHandlers(store, ipc)
  })

  clearChannels(GITHUB_ISSUE_MUTATION_CHANNELS)
  registerLazyIpcHandleGroup(GITHUB_ISSUE_MUTATION_CHANNELS, async (ipc) => {
    const { registerGitHubIssueMutationHandlers } = await import('./github-issue-mutation-handlers')
    registerGitHubIssueMutationHandlers(store, ipc)
  })

  clearChannels(GITHUB_ACCOUNT_CHANNELS)
  registerLazyIpcHandleGroup(GITHUB_ACCOUNT_CHANNELS, async (ipc) => {
    const { registerGitHubAccountHandlers } = await import('./github-account-handlers')
    registerGitHubAccountHandlers(store, ipc)
  })
}
