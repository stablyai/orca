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
  return sorted[index]
}

export function summarizeStartTimes(durations: readonly number[]): HostedSandboxTiming | undefined {
  const sorted = durations.filter((ms) => ms >= 0 && ms <= MAX_START_MS).sort((a, b) => a - b)
  if (sorted.length < MIN_TIMING_SAMPLES) {
    return undefined
  }
  return { p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95), samples: sorted.length }
}

/** Create-to-ready of the most recent sandboxes; undefined when too few have started. */
export async function recentCreateTiming(db: D1Database): Promise<HostedSandboxTiming | undefined> {
  const { results } = await db
    .prepare(
      `SELECT ready_at - created_at AS ms FROM sandboxes
       WHERE ready_at IS NOT NULL
       ORDER BY rowid DESC LIMIT ?`
    )
    .bind(RECENT_ROWS)
    .all<{ ms: number }>()
  return summarizeStartTimes(results.map((row) => row.ms))
}
