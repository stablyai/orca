// Usage history for Plan & billing: sandbox hours per day for the last 30 days, the caller's own
// share, and (for owners and admins only) the top members and sandboxes. Read-only over
// usage_events; hours are the same weighted seconds the included-hours meter counts. A segment
// counts on the day it ended, as it counts in the allowance window it ended in.
import { z } from 'zod'
import type { BillingCaller } from './auth'

export const USAGE_HISTORY_DAYS = 30
// The desktop names up to 5 live ones; 20 leaves room when the busiest were since deleted (V3-06).
export const USAGE_HISTORY_TOP = 20
const DAY_MS = 24 * 3600 * 1000

/** `utcOffset`: the viewer's minutes east of UTC, so days start at their local midnight. */
export const UsageHistoryQuerySchema = z.object({
  utcOffset: z.coerce.number().int().min(-840).max(840).default(0)
})

export type UsageHistoryTop<K extends string> = {
  top: Array<{ [key in K]: string } & { seconds: number }>
  /** Everyone (or everything) past the top entries, plus segments with no member recorded. */
  otherCount: number
  otherSeconds: number
}

export type UsageHistory = {
  /** Oldest first, exactly USAGE_HISTORY_DAYS entries; `start` is the local midnight in epoch ms. */
  days: Array<{ start: number; seconds: number }>
  totalSeconds: number
  /** The caller's own sandbox hours in the same days. */
  yourSeconds: number
  /** Owners and admins only; null for members. */
  members: UsageHistoryTop<'userId'> | null
  sandboxes: UsageHistoryTop<'sandboxId'> | null
}

/** Epoch ms of the local midnight that starts the oldest day shown. */
export function usageHistoryStart(now: number, utcOffsetMinutes: number): number {
  const offset = utcOffsetMinutes * 60_000
  const today = Math.floor((now + offset) / DAY_MS) * DAY_MS - offset
  return today - (USAGE_HISTORY_DAYS - 1) * DAY_MS
}

function topOf<K extends string>(
  key: K,
  rows: Array<{ id: string | null; seconds: number }>
): UsageHistoryTop<K> {
  const named = rows.filter((row) => row.id !== null).sort((a, b) => b.seconds - a.seconds)
  const top = named.slice(0, USAGE_HISTORY_TOP)
  const rest = [...named.slice(USAGE_HISTORY_TOP), ...rows.filter((row) => row.id === null)]
  return {
    top: top.map((row) => ({ [key]: row.id, seconds: row.seconds }) as { [k in K]: string } & { seconds: number }),
    otherCount: rest.filter((row) => row.id !== null).length,
    otherSeconds: rest.reduce((sum, row) => sum + row.seconds, 0)
  }
}

export async function usageHistory(
  db: D1Database,
  caller: BillingCaller,
  now: number,
  utcOffsetMinutes: number
): Promise<UsageHistory> {
  const start = usageHistoryStart(now, utcOffsetMinutes)
  const range = 'account_id = ?1 AND ended_at >= ?2 AND ended_at <= ?3'
  const [byDay, mine, byMember, bySandbox] = await Promise.all([
    db
      .prepare(
        `SELECT CAST((ended_at - ?2) / ${DAY_MS} AS INTEGER) AS day, SUM(weighted_seconds) AS seconds
         FROM usage_events WHERE ${range} GROUP BY day`
      )
      .bind(caller.accountId, start, now)
      .all<{ day: number; seconds: number }>(),
    db
      .prepare(`SELECT COALESCE(SUM(weighted_seconds), 0) AS seconds FROM usage_events WHERE ${range} AND user_id = ?4`)
      .bind(caller.accountId, start, now, caller.userId)
      .first<{ seconds: number }>(),
    caller.canManage
      ? db
          .prepare(`SELECT user_id AS id, SUM(weighted_seconds) AS seconds FROM usage_events WHERE ${range} GROUP BY user_id`)
          .bind(caller.accountId, start, now)
          .all<{ id: string | null; seconds: number }>()
      : null,
    caller.canManage
      ? db
          .prepare(`SELECT sandbox_id AS id, SUM(weighted_seconds) AS seconds FROM usage_events WHERE ${range} GROUP BY sandbox_id`)
          .bind(caller.accountId, start, now)
          .all<{ id: string; seconds: number }>()
      : null
  ])
  const days = Array.from({ length: USAGE_HISTORY_DAYS }, (_, index) => ({ start: start + index * DAY_MS, seconds: 0 }))
  for (const row of byDay.results) {
    const day = days[row.day]
    if (day) {
      day.seconds += row.seconds
    }
  }
  return {
    days,
    totalSeconds: days.reduce((sum, day) => sum + day.seconds, 0),
    yourSeconds: mine?.seconds ?? 0,
    members: byMember ? topOf('userId', byMember.results) : null,
    sandboxes: bySandbox ? topOf('sandboxId', bySandbox.results) : null
  }
}
