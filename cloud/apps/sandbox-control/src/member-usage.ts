// Model spend by member and UTC hour, for teammate profiles' heatmap (team-presence.ts). The
// workspace registry keeps only a cumulative per-workspace total; this dates each increase and
// credits whoever's client reported it.
const HOUR_MS = 3_600_000

/** Records the reporter's new model spend: the growth of a workspace's cumulative token total. */
export async function recordTokenSpend(
  db: D1Database,
  accountId: string,
  userId: string,
  previousUsdMicros: number | null,
  nextUsdMicros: number,
  now: number
): Promise<void> {
  const delta = nextUsdMicros - (previousUsdMicros ?? 0)
  if (delta <= 0) {
    return
  }
  await db
    .prepare(
      `INSERT INTO member_usage_hours (account_id, user_id, hour, token_usd_micros) VALUES (?, ?, ?, ?)
       ON CONFLICT (account_id, user_id, hour) DO UPDATE SET token_usd_micros = token_usd_micros + excluded.token_usd_micros`
    )
    .bind(accountId, userId, Math.floor(now / HOUR_MS), delta)
    .run()
}
