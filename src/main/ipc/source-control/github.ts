import type { Store } from '../../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { StatsCollector } from '../../stats/collector'
import { registerGitHubAccountHandlers } from './github-account-handlers'
import { registerGitHubIssueMutationHandlers } from './github-issue-mutation-handlers'
import { registerGitHubPRMutationHandlers } from './github-pr-mutation-handlers'
import { registerGitHubPRReadHandlers } from './github-pr-read-handlers'
import { registerGitHubPRRefreshHandlers } from './github-pr-refresh-handlers'
import { registerGitHubPRDetailRecoveryHandlers } from './github-pr-detail-recovery-handlers'
import { registerGitHubPRReviewHandlers } from './github-pr-review-handlers'
import { registerGitHubProjectViewHandlers } from './github-project-view-handlers'
import { registerGitHubWorkItemHandlers } from './github-work-item-handlers'

export function registerGitHubHandlers(
  store: Store,
  stats: StatsCollector,
  runtime: Pick<OrcaRuntimeService, 'notifyPullRequestChangedForRemoteClients'>
): void {
  registerGitHubPRRefreshHandlers(store, stats, runtime)
  registerGitHubPRDetailRecoveryHandlers(store)
  registerGitHubWorkItemHandlers(store)
  registerGitHubPRReadHandlers(store)
  registerGitHubPRReviewHandlers(store)
  registerGitHubPRMutationHandlers(store)
  registerGitHubIssueMutationHandlers(store)
  registerGitHubAccountHandlers(store)
  registerGitHubProjectViewHandlers()
}
