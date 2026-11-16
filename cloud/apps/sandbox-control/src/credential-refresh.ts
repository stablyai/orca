// The central credential refresher. With credentials swapped at the sandbox firewall, nothing
// sees a provider's 401 any more, so every credential class that expires is renewed ahead of time here, and
// every change (refresh, expiry, revoke, removal) is pushed into the policies of the running sandboxes that
// carry it. In-VM CLIs never refresh anything themselves: they only ever hold placeholders.
//
//   class                       lifetime   refreshed           single-flight            pushed to
//   Codex (ChatGPT sign-in)     ~10 days   3 days ahead        codex_leases lease+CAS   owner's running sandboxes
//   GitHub user token (member)  8 h        60 min ahead        row lease + CAS          sandboxes the member can push from
//   GitHub App installation     1 h        20 min ahead        reconcile (one per tick) that sandbox (reconcile.ts)
//   Claude setup-token          ~1 year    not refreshable     -                        owner's sandboxes on expiry/revoke
//
// Revocation without a 401: Claude sign-ins in use are checked on a schedule (agent-credential-checks.ts,
// rate-limited); a failure only marks them "needs check" (Renew), never revokes. Codex's are proven alive by
// each refresh (a dead refresh token ends the login).
//
// Pushes go through the outbox in credential-outbox.ts.
import type { CredentialAgent } from './agent-credential-names'
import { markCredentialChanged } from './credential-outbox'
import { dueGitHubUserTokens, refreshGitHubUserToken, type UserTokenRefreshDeps } from './github-user-tokens'

/** Refresh GitHub user tokens this long before they expire (8 h tokens; the lazy path waits for 30 min). */
export const GITHUB_USER_REFRESH_AHEAD_MS = 60 * 60_000
const REFRESH_BATCH = 20

// ---- expiry -----------------------------------------------------------------------------------------------

/**
 * Account sign-ins whose expiry passed since it was last pushed: their sandboxes still hold the real value in
 * the policy (the firewall can't tell the time), so each one is rewritten to the "sign in again" answer once.
 */
export async function markExpiredAccountCredentials(db: D1Database, now: number): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT user_id, agent, expires_at FROM agent_credentials
       WHERE state = 'active' AND expires_at IS NOT NULL AND expires_at <= ?
         AND (expiry_pushed_at IS NULL OR expiry_pushed_at < expires_at)
       LIMIT 50`
    )
    .bind(now)
    .all<{ user_id: string; agent: CredentialAgent; expires_at: number }>()
  for (const row of results) {
    await markCredentialChanged(db, { kind: 'account', agent: row.agent, userId: row.user_id }, now)
    await db
      .prepare(`UPDATE agent_credentials SET expiry_pushed_at = ? WHERE user_id = ? AND agent = ? AND expires_at = ?`)
      .bind(now, row.user_id, row.agent, row.expires_at)
      .run()
  }
  return results.length
}

// ---- GitHub user tokens -------------------------------------------------------------------------------------

export type GitHubUserRefreshSummary = { due: number; refreshed: number; failed: number; dead: number; skipped: number }

/** Refreshes every due member token (one lease each) and records the change for its sandboxes. */
export async function refreshGitHubUserTokens(deps: UserTokenRefreshDeps): Promise<GitHubUserRefreshSummary> {
  const due = await dueGitHubUserTokens(deps.db, deps.now(), GITHUB_USER_REFRESH_AHEAD_MS, REFRESH_BATCH)
  const summary: GitHubUserRefreshSummary = { due: due.length, refreshed: 0, failed: 0, dead: 0, skipped: 0 }
  for (const key of due) {
    const outcome = await refreshGitHubUserToken(deps, key, { aheadMs: GITHUB_USER_REFRESH_AHEAD_MS })
    summary[outcome]++
  }
  return summary
}

