import type { Store } from '../../persistence/loading-store/store'
import type { StatsCollector } from '../../stats/collector'
import type { CommitMessageAgentEnvironmentResolvers } from '../../text-generation/commit-message-agent-environment'
import { registerGitHubHandlers } from '../github'
import { registerGitLabHandlers } from '../gitlab'
import { registerHostedReviewHandlers } from '../hosted-review'
import { registerLinearHandlers } from '../linear/register-handlers'
import { registerJiraHandlers } from '../jira/register-handlers'
import { registerAzureDevOpsBoardsHandlers } from '../azure-devops-boards'
import { registerJiraIssueSummaryGenerationHandlers } from '../jira/issue-summary-generation'
import { registerBitbucketHandlers } from '../bitbucket'

/**
 * Task sources and the hosted review that talks to the same providers, grouped
 * so that adding a provider does not grow the core registrar past its limit.
 */
export function registerTaskProviderHandlers(
  store: Store,
  stats: StatsCollector,
  commitMessageAgentEnv?: CommitMessageAgentEnvironmentResolvers
): void {
  registerGitHubHandlers(store, stats)
  registerGitLabHandlers(store)
  registerHostedReviewHandlers(store, stats)
  registerLinearHandlers()
  registerJiraHandlers()
  registerAzureDevOpsBoardsHandlers(store)
  registerJiraIssueSummaryGenerationHandlers(store, commitMessageAgentEnv)
  registerBitbucketHandlers()
}
