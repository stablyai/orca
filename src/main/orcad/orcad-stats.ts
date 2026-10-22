import { feedAgentSessionStats, type AgentStatusSource } from '../stats/agent-session-stats-feed'
import { initStatsPath, StatsCollector } from '../stats/collector'
import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'

/** `stats.summary` and the mobile home totals read this; without it they answer zeros (#31112). */
export function startOrcadStats(
  userDataPath: string,
  hooks: AgentStatusSource,
  registerCleanup: (cleanup: OrcadRuntimeCleanup) => void
): StatsCollector {
  initStatsPath(userDataPath)
  const stats = new StatsCollector()
  // Registered first so it runs last: the feed and RPC stop before the final write.
  registerCleanup(() => stats.flushAsync())
  registerCleanup(feedAgentSessionStats(stats, hooks))
  return stats
}
