import { existsSync, readFileSync } from 'node:fs'
import type { StatsAggregates, StatsFile } from './types'

export const STATS_SCHEMA_VERSION = 1

function defaultAggregates(): StatsAggregates {
  return {
    totalAgentsSpawned: 0,
    totalPRsCreated: 0,
    totalAgentTimeMs: 0,
    countedPRs: [],
    firstEventAt: null
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
        aggregates: { ...defaultAggregates(), ...parsed.aggregates }
      }
    }
  } catch (err) {
    console.error('[stats] Failed to load stats, starting fresh:', err)
  }
  return defaultStatsFile()
}
