import { feedAgentSessionStats, type AgentStatusSource } from '../../stats/agent-session-stats-feed'
import { initStatsPath, StatsCollector } from '../../stats/collector'
import type { BackendServiceCleanup } from '../../backend/service-composition'
import { feedPullRequestStats } from '../../stats/pull-request-stats-feed'

export function startOrcadStats(
  userDataPath: string,
  hooks: AgentStatusSource,
  registerCleanup: (cleanup: BackendServiceCleanup) => void,
  readRepos: Parameters<typeof feedPullRequestStats>[1]
): StatsCollector {
  initStatsPath(userDataPath)
  const stats = new StatsCollector()
  // Reverse cleanup order stops feeds/RPC before the final stats flush.
  registerCleanup(() => stats.flushAsync())
  registerCleanup(feedAgentSessionStats(stats, hooks))
  registerCleanup(feedPullRequestStats(stats, readRepos))
  return stats
}
