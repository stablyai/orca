import type { Store } from '../../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { StatsCollector } from '../../stats/collector'
import { registerGitHubPRReadHandlers } from './github-pr-read-handlers'
import { registerGitHubPRRefreshHandlers } from './github-pr-refresh-handlers'
import { registerGitHubWorkItemHandlers } from './github-work-item-handlers'
import { registerLazyGitHubSecondaryHandlers } from './lazy-github-secondary-handlers'

export function registerGitHubHandlers(
  store: Store,
  stats: StatsCollector,
  runtime: Pick<OrcaRuntimeService, 'notifyPullRequestChangedForRemoteClients'>
): void {
  registerGitHubPRRefreshHandlers(store, stats, runtime)
  registerGitHubWorkItemHandlers(store)
  registerGitHubPRReadHandlers(store)
  registerLazyGitHubSecondaryHandlers(store)
}
