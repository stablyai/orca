// Measured sandbox start times for GET /v1/config, so the desktop's "usually ~Ns" hint is a real median.
import type { HostedSandboxTiming } from '../../../../src/shared/hosted-sandbox/hosted-sandbox-wire'

/** Latest rows only: a cheap rowid scan, and the hint should follow the current pool and image. */
const RECENT_ROWS = 500
/** Fewer starts than this is noise, so clients show no hint rather than a guess. */
export const MIN_TIMING_SAMPLES = 10
/**
 * `ready_at` moves on every wake, so a long gap is a later wake, not a slow start. Real starts
 * finish inside the boot budget well before this.
 */
const MAX_START_MS = 120_000

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index]!
}

export function summarizeStartTimes(durations: readonly number[]): HostedSandboxTiming | undefined {
  const sorted = durations.filter((ms) => ms >= 0 && ms <= MAX_START_MS).sort((a, b) => a - b)
  if (sorted.length < MIN_TIMING_SAMPLES) {
    return undefined
  }
  return { p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95), samples: sorted.length }
}

/**
 * Create-to-ready of the most recent sandboxes (create_ms, written once at first ready; ready_at -
 * created_at also counted later wakes); undefined when too few have started.
 */
export async function recentCreateTiming(db: D1Database): Promise<HostedSandboxTiming | undefined> {
  return recentTiming(db, 'create_ms')
}

/** Resume-to-ready of the most recent wakes. */
export async function recentWakeTiming(db: D1Database): Promise<HostedSandboxTiming | undefined> {
  return recentTiming(db, 'wake_ms')
}

async function recentTiming(db: D1Database, column: 'create_ms' | 'wake_ms'): Promise<HostedSandboxTiming | undefined> {
  const { results } = await db
    .prepare(`SELECT ${column} AS ms FROM sandboxes WHERE ${column} IS NOT NULL ORDER BY rowid DESC LIMIT ?`)
    .bind(RECENT_ROWS)
    .all<{ ms: number }>()
  return summarizeStartTimes(results.map((row) => row.ms))
}

const CACHE_MS = 5 * 60_000
let cache: { db: D1Database; at: number; value: Promise<HostedSandboxTiming | undefined> } | null = null

/**
 * GET /v1/config is public, so the query runs at most once per isolate every 5 minutes; a failed
 * read is retried on the next request instead of being cached.
 */
export function cachedCreateTiming(db: D1Database, now: number): Promise<HostedSandboxTiming | undefined> {
  if (cache && cache.db === db && now - cache.at < CACHE_MS) {
    return cache.value
  }
  const entry = {
    db,
    at: now,
    value: recentCreateTiming(db).catch(() => {
      if (cache === entry) {
        cache = null
      }
      return undefined
    })
  }
  cache = entry
  return entry.value
}
