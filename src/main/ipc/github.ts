import type { Store } from '../persistence'
import type { StatsCollector } from '../stats/collector'
import { registerGitHubAccountHandlers } from './github-account-handlers'
import { registerGitHubIssueMutationHandlers } from './github-issue-mutation-handlers'
import { registerGitHubPRMutationHandlers } from './github-pr-mutation-handlers'
import { registerGitHubPRReadHandlers } from './github-pr-read-handlers'
import { registerGitHubPRRefreshHandlers } from './github-pr-refresh-handlers'
import { registerGitHubPRReviewHandlers } from './github-pr-review-handlers'
import { registerGitHubProjectViewHandlers } from './github-project-view-handlers'
import { registerGitHubWorkItemHandlers } from './github-work-item-handlers'

import { registerGitHubActionsReadHandlers } from './github-actions-read-handlers'

/** Compose GitHub IPC handlers around the same store so Actions shares existing repository/account routing. */
export function registerGitHubHandlers(store: Store, stats: StatsCollector): void {
  registerGitHubActionsReadHandlers(store)
  registerGitHubPRRefreshHandlers(store, stats)
  registerGitHubWorkItemHandlers(store)
  registerGitHubPRReadHandlers(store)
  registerGitHubPRReviewHandlers(store)
  registerGitHubPRMutationHandlers(store)
  registerGitHubIssueMutationHandlers(store)
  registerGitHubAccountHandlers(store)
  registerGitHubProjectViewHandlers()
}
