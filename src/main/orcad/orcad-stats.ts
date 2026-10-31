import { feedAgentSessionStats, type AgentStatusSource } from '../stats/agent-session-stats-feed'
import { initStatsPath, StatsCollector } from '../stats/collector'
import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'

// Stats & Usage token analytics start with the runtime, so the entry imports both from here.
export { startOrcadUsageAnalytics } from './orcad-usage-analytics'

export function startOrcadStats(
  userDataPath: string,
  hooks: AgentStatusSource,
  registerCleanup: (cleanup: OrcadRuntimeCleanup) => void
): StatsCollector {
  initStatsPath(userDataPath)
  const stats = new StatsCollector()
  // Reverse cleanup order stops feeds/RPC before the final stats flush.
  registerCleanup(() => stats.flushAsync())
  registerCleanup(feedAgentSessionStats(stats, hooks))
  return stats
}
