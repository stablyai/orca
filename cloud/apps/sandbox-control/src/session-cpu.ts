// U22: internal-only CPU tracking. Customers keep flat sandbox hours; this records each session's
// measured active CPU (Vercel reports it after the VM stops) so operators can spot fair-use outliers.
// Never touches usage_outbox, billing or a customer route, and never blocks a stop: every entry
// point swallows its own failures, and the cron sweep fills in what the stop couldn't read.
import { SANDBOX_VCPUS } from './machine-size'
import type { ProviderSessionUsage, SandboxProviderApi } from './sandbox-provider'
import type { SandboxRow } from './store'

export const FAIR_USE_WINDOW_DAYS = 30
/** Average active CPU over vCPU-time above this flags an account for review. */
export const FAIR_USE_THRESHOLD = 0.6
/** Sessions older than this without CPU are given up on (the provider may have forgotten them). */
const SWEEP_WINDOW_MS = 7 * 24 * 60 * 60_000
const SWEEP_MAX_ATTEMPTS = 12
const SWEEP_BATCH = 25

/**
 * Records a session that just ended; idempotent per session id. `usage` is whatever the stop
 * answered (often no CPU yet). Never throws.
 */
export async function recordSessionEnd(
  db: D1Database,
  row: SandboxRow,
  endedAt: number,
  usage: ProviderSessionUsage | null | undefined,
  now: number
): Promise<void> {
  try {
    if (!row.session_id) {
      return
    }
    const vcpus = positive(usage?.vcpus) ?? SANDBOX_VCPUS
    const startedAt = row.session_started_at
    const wallMs = positive(usage?.durationMs) ?? (startedAt !== null ? Math.max(0, endedAt - startedAt) : 0)
    await db
      .prepare(
        `INSERT OR IGNORE INTO session_cpu
           (session_id, sandbox_id, account_id, user_id, vcpus, memory_mb, wall_ms, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(row.session_id, row.id, row.account_id, row.user_id ?? null, vcpus, positive(usage?.memoryMb), wallMs, startedAt, endedAt)
      .run()
    if (usage) {
      await applyUsage(db, row.session_id, usage, now)
    }
  } catch {
    // Internal review data only: a D1 or shape problem must never fail the stop.
  }
}

/** Fills CPU on a pending row; first answer wins (re-fetching never rewrites a recorded value). */
async function applyUsage(db: D1Database, sessionId: string, usage: ProviderSessionUsage, now: number): Promise<boolean> {
  if (usage.activeCpuMs === null || !Number.isFinite(usage.activeCpuMs) || usage.activeCpuMs < 0) {
    return false
  }
  const result = await db
    .prepare(
      `UPDATE session_cpu SET active_cpu_ms = ?, fetched_at = ?,
         wall_ms = COALESCE(?, wall_ms), vcpus = COALESCE(?, vcpus), memory_mb = COALESCE(?, memory_mb)
       WHERE session_id = ? AND active_cpu_ms IS NULL`
    )
    .bind(
      Math.round(usage.activeCpuMs),
      now,
      positive(usage.durationMs),
      positive(usage.vcpus),
      positive(usage.memoryMb),
      sessionId
    )
    .run()
  return (result.meta?.changes ?? 0) > 0
}

export type SessionCpuSweep = { checked: number; recorded: number; failed: number }

/** Cron: asks the provider again for recent sessions still missing CPU. Never throws. */
export async function sweepSessionCpu(
  db: D1Database,
  provider: Pick<SandboxProviderApi, 'getSessionUsage'>,
  now: number
): Promise<SessionCpuSweep> {
  const summary: SessionCpuSweep = { checked: 0, recorded: 0, failed: 0 }
  if (!provider.getSessionUsage) {
    return summary
  }
  let pending: { session_id: string }[]
  try {
    pending = (
      await db
        .prepare(
          `SELECT session_id FROM session_cpu
           WHERE active_cpu_ms IS NULL AND ended_at >= ? AND attempts < ?
           ORDER BY ended_at DESC LIMIT ?`
        )
        .bind(now - SWEEP_WINDOW_MS, SWEEP_MAX_ATTEMPTS, SWEEP_BATCH)
        .all<{ session_id: string }>()
    ).results
  } catch {
    return summary
  }
  for (const { session_id } of pending) {
    summary.checked++
    try {
      const usage = await provider.getSessionUsage(session_id)
      if (usage && (await applyUsage(db, session_id, usage, now))) {
        summary.recorded++
        continue
      }
    } catch {
      summary.failed++
    }
    await db
      .prepare('UPDATE session_cpu SET attempts = attempts + 1 WHERE session_id = ?')
      .bind(session_id)
      .run()
      .catch(() => undefined)
  }
  return summary
}

export type FairUseAccount = {
  accountId: string
  sessions: number
  activeCpuMs: number
  vcpuMs: number
  /** sum(active_cpu_ms) / sum(wall_ms × vcpus), 0..1 (null when there is no measured time). */
  cpuUtilization: number | null
  fairUseFlag: boolean
}

export type FairUseReport = {
  windowDays: number
  since: number
  threshold: number
  /** Ended sessions in the window still waiting for the provider's CPU figure (excluded from the math). */
  pendingSessions: number
  accounts: FairUseAccount[]
}

/** Operator-only. Per account over the window; highest utilisation first. */
export async function fairUseReport(db: D1Database, now: number, windowDays = FAIR_USE_WINDOW_DAYS): Promise<FairUseReport> {
  const since = now - windowDays * 24 * 60 * 60_000
  const { results } = await db
    .prepare(
      `SELECT account_id, COUNT(*) AS sessions, SUM(active_cpu_ms) AS active_cpu_ms, SUM(wall_ms * vcpus) AS vcpu_ms
       FROM session_cpu WHERE ended_at >= ? AND active_cpu_ms IS NOT NULL
       GROUP BY account_id`
    )
    .bind(since)
    .all<{ account_id: string; sessions: number; active_cpu_ms: number; vcpu_ms: number }>()
  const pending = await db
    .prepare('SELECT COUNT(*) AS n FROM session_cpu WHERE ended_at >= ? AND active_cpu_ms IS NULL')
    .bind(since)
    .first<{ n: number }>()
  const accounts = results
    .map((row): FairUseAccount => {
      const vcpuMs = Number(row.vcpu_ms) || 0
      const activeCpuMs = Number(row.active_cpu_ms) || 0
      const ratio = vcpuMs > 0 ? activeCpuMs / vcpuMs : null
      return {
        accountId: row.account_id,
        sessions: Number(row.sessions),
        activeCpuMs,
        vcpuMs,
        cpuUtilization: ratio === null ? null : Math.round(ratio * 10_000) / 10_000,
        fairUseFlag: ratio !== null && ratio > FAIR_USE_THRESHOLD
      }
    })
    .sort((a, b) => (b.cpuUtilization ?? -1) - (a.cpuUtilization ?? -1))
  return { windowDays, since, threshold: FAIR_USE_THRESHOLD, pendingSessions: Number(pending?.n ?? 0), accounts }
}

function positive(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null
}
