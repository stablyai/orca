import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'
import type { Store } from '../../persistence/loading-store/store'

const GITEA_IPC_CHANNELS = [
  'gitea:prDetail',
  'gitea:prFiles',
  'gitea:prFileContents',
  'gitea:prChecks',
  'gitea:prMerge',
  'gitea:prReviewComments',
  'gitea:prAddReviewComment',
  'gitea:connect',
  'gitea:disconnect',
  'gitea:status',
  'gitea:testConnection',
  'gitea:listWorkItems',
  'gitea:issue',
  'gitea:issueComments',
  'gitea:labels',
  'gitea:assignees',
  'gitea:createIssue',
  'gitea:updateIssue',
  'gitea:addIssueComment'
] as const

export function registerLazyGiteaHandlers(store: Store): void {
  registerLazyIpcHandleGroup(GITEA_IPC_CHANNELS, async (ipc) => {
    const { registerGiteaHandlers } = await import('./gitea')
    registerGiteaHandlers(store, ipc)
  })
}
