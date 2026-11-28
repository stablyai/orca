import { ipcMain } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { StatsCollector } from '../../stats/collector'
import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'
import { registerGitHubPRRefreshHandlers } from './github-pr-refresh-handlers'
import { registerLazyGitHubSecondaryHandlers } from './lazy-github-secondary-handlers'

const GITHUB_WORK_ITEM_CHANNELS = [
  'gh:issue',
  'gh:listIssues',
  'gh:createIssue',
  'gh:listWorkItems',
  'gh:countWorkItems',
  'gh:workItem',
  'gh:workItemByOwnerRepo',
  'gh:workItemDetails',
  'gh:notifyWorkItemMutated',
  'gh:prFileContents'
] as const

const GITHUB_PR_READ_CHANNELS = [
  'gh:repoSlug',
  'gh:repoUpstream',
  'gh:prChecks',
  'gh:prCheckDetails',
  'gh:prComments',
  'gh:setPRCommentReaction',
  'gh:resolveReviewThread'
] as const

function clearChannels(channels: readonly string[]): void {
  for (const channel of channels) {
    ipcMain.removeHandler(channel)
  }
}

export function registerGitHubHandlers(
  store: Store,
  stats: StatsCollector,
  runtime: Pick<OrcaRuntimeService, 'notifyPullRequestChangedForRemoteClients'>
): void {
  registerGitHubPRRefreshHandlers(store, stats, runtime)

  clearChannels(GITHUB_WORK_ITEM_CHANNELS)
  registerLazyIpcHandleGroup(GITHUB_WORK_ITEM_CHANNELS, async (ipc) => {
    const { registerGitHubWorkItemHandlers } = await import('./github-work-item-handlers')
    registerGitHubWorkItemHandlers(store, ipc)
  })

  clearChannels(GITHUB_PR_READ_CHANNELS)
  registerLazyIpcHandleGroup(GITHUB_PR_READ_CHANNELS, async (ipc) => {
    const { registerGitHubPRReadHandlers } = await import('./github-pr-read-handlers')
    registerGitHubPRReadHandlers(store, ipc)
  })

  registerLazyGitHubSecondaryHandlers(store)
}
