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

export function registerGitHubHandlers(store: Store, stats: StatsCollector): void {
  registerGitHubPRRefreshHandlers(store, stats)
  registerGitHubWorkItemHandlers(store)
  registerGitHubPRReadHandlers(store)
  registerGitHubPRReviewHandlers(store)
  registerGitHubPRMutationHandlers(store)
  registerGitHubIssueMutationHandlers(store)
  registerGitHubAccountHandlers()
  registerGitHubProjectViewHandlers()
}
