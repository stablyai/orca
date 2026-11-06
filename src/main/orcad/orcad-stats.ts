import { setClaudeSessionMoveStatsRecorder } from '../claude-accounts/claude-session-move-stats'
import { feedAgentSessionStats, type AgentStatusSource } from '../stats/agent-session-stats-feed'
import { initStatsPath, StatsCollector } from '../stats/collector'
import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'

export function startOrcadStats(
  userDataPath: string,
  hooks: AgentStatusSource,
  registerCleanup: (cleanup: OrcadRuntimeCleanup) => void
): StatsCollector {
  initStatsPath(userDataPath)
  const stats = new StatsCollector()
  setClaudeSessionMoveStatsRecorder((stat) => stats.recordClaudeSessionMove(stat))
  // Reverse cleanup order stops feeds before the recorder, then flushes.
  registerCleanup(() => stats.flushAsync())
  registerCleanup(() => {
    setClaudeSessionMoveStatsRecorder(null)
  })
  registerCleanup(feedAgentSessionStats(stats, hooks))
  return stats
}
