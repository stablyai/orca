// Metering: running time becomes outbox segments, then billing usage reports (overage → Stripe there).
import type { EntitlementClient, MachineSize, UsageAnswer } from './entitlements'
import type { SandboxRow } from './store'

const MAX_SEGMENT_MS = 24 * 60 * 60_000
const MAX_ATTEMPTS = 50

type OutboxRow = {
  usage_id: string
  sandbox_id: string
  account_id: string
  machine_size: MachineSize
  started_at: number
  ended_at: number
  attempts: number
}

/** Queues the row's unsettled time up to `until`; returns the new settle cursor (unchanged if none). */
export async function queueUsage(db: D1Database, row: SandboxRow, until: number): Promise<number | null> {
  const from = row.usage_settled_at
  if (from === null || row.session_id === null || until <= from) {
    return from
  }
  const statements = []
  for (let start = from; start < until; start += MAX_SEGMENT_MS) {
    const end = Math.min(until, start + MAX_SEGMENT_MS)
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO usage_outbox (usage_id, sandbox_id, account_id, machine_size, started_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(`${row.id}:${row.session_id}:${start}`, row.id, row.account_id, row.machine_size, start, end)
    )
  }
  await db.batch(statements)
  return until
}

/** Sends pending segments (one sandbox, or the oldest for the cron). Returns billing's last answer. */
export async function flushUsage(
  db: D1Database,
  entitlements: EntitlementClient,
  now: number,
  sandboxId?: string
): Promise<UsageAnswer | null> {
  const { results } = await db
    .prepare(
      `SELECT * FROM usage_outbox WHERE sent_at IS NULL AND attempts < ? ${sandboxId ? 'AND sandbox_id = ?' : ''}
       ORDER BY started_at LIMIT 100`
    )
    .bind(...(sandboxId ? [MAX_ATTEMPTS, sandboxId] : [MAX_ATTEMPTS]))
    .all<OutboxRow>()
  let answer: UsageAnswer | null = null
  for (const segment of results) {
    try {
      answer = await entitlements.reportUsage({
        usageId: segment.usage_id,
        accountId: segment.account_id,
        sandboxId: segment.sandbox_id,
        machineSize: segment.machine_size,
        startedAt: segment.started_at,
        endedAt: segment.ended_at
      })
      await db.prepare('UPDATE usage_outbox SET sent_at = ? WHERE usage_id = ?').bind(now, segment.usage_id).run()
    } catch {
      await db
        .prepare('UPDATE usage_outbox SET attempts = attempts + 1 WHERE usage_id = ?')
        .bind(segment.usage_id)
        .run()
      break
    }
  }
  return answer
}
