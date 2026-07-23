import type { StatsSummary } from '../../shared/types'
import type { StatsAggregates, StatsEvent } from './types'
import {
  jsonByteLengthWithinLimit,
  STATS_COUNTED_PR_MAX_ENTRIES,
  STATS_COUNTED_PR_MAX_RETAINED_BYTES,
  STATS_COUNTED_PR_URL_MAX_BYTES
} from './stats-retention'

export class StatsAggregateTracker {
  private countedPrRetainedBytes: number

  constructor(readonly aggregates: StatsAggregates) {
    this.countedPrRetainedBytes = aggregates.countedPRs.reduce(
      (total, value) =>
        total + (jsonByteLengthWithinLimit(value, STATS_COUNTED_PR_URL_MAX_BYTES) ?? 0),
      0
    )
  }

  record(event: StatsEvent, agentStartListeners: ((total: number) => void)[]): void {
    if (this.aggregates.firstEventAt === null) {
      this.aggregates.firstEventAt = event.at
    }
    if (event.type === 'agent_start') {
      this.aggregates.totalAgentsSpawned++
      for (const listener of agentStartListeners) {
        try {
          listener(this.aggregates.totalAgentsSpawned)
        } catch (err) {
          console.error('[stats] agent-start listener threw:', err)
        }
      }
      return
    }
    if (event.type !== 'pr_created') {
      return
    }
    this.aggregates.totalPRsCreated++
    if (!event.meta?.prUrl) {
      return
    }
    const prUrl = String(event.meta.prUrl)
    const prUrlBytes = jsonByteLengthWithinLimit(prUrl, STATS_COUNTED_PR_URL_MAX_BYTES)
    if (prUrlBytes === null) {
      return
    }
    this.aggregates.countedPRs.push(prUrl)
    this.countedPrRetainedBytes += prUrlBytes
    while (
      this.aggregates.countedPRs.length > STATS_COUNTED_PR_MAX_ENTRIES ||
      this.countedPrRetainedBytes > STATS_COUNTED_PR_MAX_RETAINED_BYTES
    ) {
      const oldestPrUrl = this.aggregates.countedPRs.shift()
      if (oldestPrUrl === undefined) {
        break
      }
      this.countedPrRetainedBytes -=
        jsonByteLengthWithinLimit(oldestPrUrl, STATS_COUNTED_PR_URL_MAX_BYTES) ?? 0
    }
  }

  getSummary(): StatsSummary {
    return {
      totalAgentsSpawned: this.aggregates.totalAgentsSpawned,
      totalPRsCreated: this.aggregates.totalPRsCreated,
      totalAgentTimeMs: this.aggregates.totalAgentTimeMs,
      firstEventAt: this.aggregates.firstEventAt
    }
  }
}
