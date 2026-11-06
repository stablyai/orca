import { existsSync, readFileSync } from 'node:fs'
import type { ClaudeSessionMoveStats, StatsAggregates, StatsFile } from './types'

export const STATS_SCHEMA_VERSION = 1

function defaultClaudeSessionMoves(): ClaudeSessionMoveStats {
  return { resume: 0, proxy: 0, rebalances: 0, failures: 0 }
}

function defaultAggregates(): StatsAggregates {
  return {
    totalAgentsSpawned: 0,
    totalPRsCreated: 0,
    totalAgentTimeMs: 0,
    countedPRs: [],
    firstEventAt: null,
    claudeSessionMoves: defaultClaudeSessionMoves()
  }
}

function defaultStatsFile(): StatsFile {
  return {
    schemaVersion: STATS_SCHEMA_VERSION,
    events: [],
    aggregates: defaultAggregates()
  }
}

export function loadStatsFile(statsFile: string): StatsFile {
  try {
    if (existsSync(statsFile)) {
      const parsed = JSON.parse(readFileSync(statsFile, 'utf-8')) as StatsFile
      return {
        ...defaultStatsFile(),
        ...parsed,
        aggregates: {
          ...defaultAggregates(),
          ...parsed.aggregates,
          // A file written before this field, or with only some counters, must not drop the rest.
          claudeSessionMoves: {
            ...defaultClaudeSessionMoves(),
            ...parsed.aggregates?.claudeSessionMoves
          }
        }
      }
    }
  } catch (err) {
    console.error('[stats] Failed to load stats, starting fresh:', err)
  }
  return defaultStatsFile()
}
