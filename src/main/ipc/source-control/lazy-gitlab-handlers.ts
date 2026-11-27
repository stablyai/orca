import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'
import type { Store } from '../../persistence/loading-store/store'

const GITLAB_IPC_CHANNELS = [
  'gitlab:viewer',
  'gitlab:diagnoseAuth',
  'gitlab:rateLimit',
  'gitlab:projectSlug',
  'gitlab:todos',
  'gitlab:mrForBranch',
  'gitlab:mr',
  'gitlab:listMRs',
  'gitlab:issue',
  'gitlab:listIssues',
  'gitlab:createIssue',
  'gitlab:updateIssue',
  'gitlab:addIssueComment',
  'gitlab:listLabels',
  'gitlab:listAssignableUsers',
  'gitlab:listWorkItems',
  'gitlab:workItemDetails',
  'gitlab:workItemByPath',
  'gitlab:closeMR',
  'gitlab:reopenMR',
  'gitlab:mergeMR',
  'gitlab:updateMR',
  'gitlab:updateMRReviewers',
  'gitlab:addMRComment',
  'gitlab:addMRInlineComment',
  'gitlab:resolveMRDiscussion',
  'gitlab:jobTrace',
  'gitlab:retryJob'
] as const

export function registerLazyGitLabHandlers(store: Store): void {
  registerLazyIpcHandleGroup(GITLAB_IPC_CHANNELS, async (ipc) => {
    const { registerGitLabHandlers } = await import('./gitlab')
    registerGitLabHandlers(store, ipc)
  })
}
