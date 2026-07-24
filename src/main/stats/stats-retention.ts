import { stringifyJsonWithinByteLimit } from '../../shared/node-bounded-json-stringify'
import {
  assertJsonTextStructureWithinLimits,
  type JsonTextStructureLimits
} from '../../shared/json-text-structure-limit'
import type { StatsAggregates, StatsEvent, StatsFile } from './types'

export const STATS_SCHEMA_VERSION = 1
export const STATS_FILE_MAX_BYTES = 16 * 1024 * 1024
export const STATS_EVENT_MAX_ENTRIES = 10_000
export const STATS_EVENT_MAX_BYTES = 1024 * 1024
export const STATS_EVENT_MAX_RETAINED_BYTES = 12 * 1024 * 1024
export const STATS_LIVE_AGENT_MAX_ENTRIES = 4_096
export const STATS_LIVE_AGENT_ID_MAX_BYTES = 4 * 1024
export const STATS_LIVE_AGENT_MAX_RETAINED_ID_BYTES = 1024 * 1024
export const STATS_COUNTED_PR_MAX_ENTRIES = 2_000
export const STATS_COUNTED_PR_URL_MAX_BYTES = 8 * 1024
export const STATS_COUNTED_PR_MAX_RETAINED_BYTES = 1024 * 1024
export const STATS_FILE_JSON_LIMITS: JsonTextStructureLimits = {
  structuralTokens: 1_000_000,
  nestingDepth: 128
}

export function jsonByteLengthWithinLimit(value: unknown, maxBytes: number): number | null {
  try {
    return stringifyJsonWithinByteLimit(value, maxBytes).byteLength
  } catch {
    return null
  }
}

function normalizeLoadedEvents(values: unknown[]): StatsEvent[] {
  const newest: StatsEvent[] = []
  let retainedBytes = 0
  for (
    let index = values.length - 1;
    index >= 0 && newest.length < STATS_EVENT_MAX_ENTRIES;
    index--
  ) {
    const value = values[index]
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      continue
    }
    const event = value as StatsEvent
    const eventBytes = jsonByteLengthWithinLimit(event, STATS_EVENT_MAX_BYTES)
    if (eventBytes === null) {
      continue
    }
    if (retainedBytes + eventBytes > STATS_EVENT_MAX_RETAINED_BYTES) {
      break
    }
    retainedBytes += eventBytes
    newest.push(event)
  }
  return newest.toReversed()
}

function normalizeCountedPrUrls(values: unknown[]): string[] {
  const newest: string[] = []
  let retainedBytes = 0
  for (
    let index = values.length - 1;
    index >= 0 && newest.length < STATS_COUNTED_PR_MAX_ENTRIES;
    index--
  ) {
    const value = values[index]
    if (typeof value !== 'string') {
      continue
    }
    const valueBytes = jsonByteLengthWithinLimit(value, STATS_COUNTED_PR_URL_MAX_BYTES)
    if (valueBytes === null) {
      continue
    }
    if (retainedBytes + valueBytes > STATS_COUNTED_PR_MAX_RETAINED_BYTES) {
      break
    }
    retainedBytes += valueBytes
    newest.push(value)
  }
  return newest.toReversed()
}

export function createDefaultStatsFile(): StatsFile {
  return {
    schemaVersion: STATS_SCHEMA_VERSION,
    events: [],
    aggregates: {
      totalAgentsSpawned: 0,
      totalPRsCreated: 0,
      totalAgentTimeMs: 0,
      countedPRs: [],
      firstEventAt: null
    }
  }
}

export function normalizeLoadedStatsFile(parsed: unknown): StatsFile {
  const candidate =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Partial<StatsFile>)
      : {}
  const aggregateCandidate: Partial<StatsAggregates> =
    typeof candidate.aggregates === 'object' &&
    candidate.aggregates !== null &&
    !Array.isArray(candidate.aggregates)
      ? candidate.aggregates
      : {}
  const countedPRs = Array.isArray(aggregateCandidate.countedPRs)
    ? normalizeCountedPrUrls(aggregateCandidate.countedPRs)
    : []
  return {
    schemaVersion:
      typeof candidate.schemaVersion === 'number' ? candidate.schemaVersion : STATS_SCHEMA_VERSION,
    events: Array.isArray(candidate.events) ? normalizeLoadedEvents(candidate.events) : [],
    aggregates: {
      totalAgentsSpawned:
        typeof aggregateCandidate.totalAgentsSpawned === 'number'
          ? aggregateCandidate.totalAgentsSpawned
          : 0,
      totalPRsCreated:
        typeof aggregateCandidate.totalPRsCreated === 'number'
          ? aggregateCandidate.totalPRsCreated
          : 0,
      totalAgentTimeMs:
        typeof aggregateCandidate.totalAgentTimeMs === 'number'
          ? aggregateCandidate.totalAgentTimeMs
          : 0,
      countedPRs,
      firstEventAt:
        typeof aggregateCandidate.firstEventAt === 'number' ? aggregateCandidate.firstEventAt : null
    }
  }
}

export function parseLoadedStatsFile(
  serialized: string,
  structureLimits: JsonTextStructureLimits = STATS_FILE_JSON_LIMITS
): StatsFile {
  assertJsonTextStructureWithinLimits(serialized, structureLimits)
  return normalizeLoadedStatsFile(JSON.parse(serialized))
}

export class StatsEventLog {
  private eventByteLengths: number[]
  private retainedEventBytes: number

  constructor(readonly events: StatsEvent[]) {
    this.eventByteLengths = events.map(
      (event) => jsonByteLengthWithinLimit(event, STATS_EVENT_MAX_BYTES) ?? 0
    )
    this.retainedEventBytes = this.eventByteLengths.reduce((total, bytes) => total + bytes, 0)
  }

  retain(event: StatsEvent): void {
    const eventBytes = jsonByteLengthWithinLimit(event, STATS_EVENT_MAX_BYTES)
    if (eventBytes === null) {
      return
    }
    this.events.push(event)
    this.eventByteLengths.push(eventBytes)
    this.retainedEventBytes += eventBytes
    while (
      this.events.length > STATS_EVENT_MAX_ENTRIES ||
      this.retainedEventBytes > STATS_EVENT_MAX_RETAINED_BYTES
    ) {
      this.events.shift()
      this.retainedEventBytes -= this.eventByteLengths.shift() ?? 0
    }
  }
}
