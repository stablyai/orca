import { registerAppHandler } from './app-registry/app-handler-registry'

import type { StatsCollector } from '../stats/collector'

export function registerStatsHandlers(stats: StatsCollector): void {
  registerAppHandler('stats:summary', () => {
    return stats.getSummary()
  })
}
