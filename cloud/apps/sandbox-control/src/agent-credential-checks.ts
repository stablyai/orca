// A provider 401 on an Orca-account request (the proxy swapped the real credential in) is a signal, not a
// verdict: one transient auth error must not sign a person out of every workspace. Before revoking, the
// control plane makes one cheap server-side auth check with the real credential (no tokens spent) and
// revokes only when that also says the credential is dead. Checks are rate-limited per person and agent
// (agent_credentials.checked_at), and every decision is audited (agent_credential_audit).
import type { AccountProvider } from './account-providers'
import { markAgentCredentialRevoked, readUsableAgentCredential } from './agent-credentials'
import type { Keyring } from './secrets-crypto'

/** At most one auth check (and so one revoke) per person and agent per minute. */
export const CREDENTIAL_CHECK_INTERVAL_MS = 60_000

export type CredentialVerdict = 'valid' | 'invalid' | 'unknown'
export type UnauthorizedOutcome = 'revoked' | 'kept' | 'skipped'

async function audit(
  db: D1Database,
  entry: { userId: string; agent: string; action: 'revoked' | 'kept'; reason: string; sandboxId: string; path: string; now: number }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO agent_credential_audit (user_id, agent, action, reason, sandbox_id, upstream_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(entry.userId, entry.agent, entry.action, entry.reason, entry.sandboxId, entry.path.split('?')[0]!.slice(0, 200), entry.now)
    .run()
  console.log(JSON.stringify({ event: `agent_credential_${entry.action}`, agent: entry.agent, by: 'egress_401', reason: entry.reason, sandboxId: entry.sandboxId }))
}

export async function handleAccountUnauthorized(ctx: {
  db: D1Database
  keyring: Keyring
  provider: Pick<AccountProvider, 'agent' | 'verify'>
  userId: string
  sandboxId: string
  /** The upstream path that answered 401 (audit only; no query string). */
  path: string
  now: number
  fetch: typeof fetch
}): Promise<UnauthorizedOutcome> {
  const { db, provider, userId, now } = ctx
  const agent = provider.agent
  // Claim the check slot: a burst of parallel 401s, or a flapping provider, makes one check a minute.
  const claimed = await db
    .prepare(
      `UPDATE agent_credentials SET checked_at = ?
       WHERE user_id = ? AND agent = ? AND state = 'active' AND (checked_at IS NULL OR checked_at <= ?)`
    )
    .bind(now, userId, agent, now - CREDENTIAL_CHECK_INTERVAL_MS)
    .run()
  if (!claimed.meta.changes) {
    console.log(JSON.stringify({ event: 'agent_credential_401_skipped', agent, sandboxId: ctx.sandboxId }))
    return 'skipped'
  }
  const real = await readUsableAgentCredential(db, ctx.keyring, userId, agent, now)
  if (!real) {
    return 'skipped'
  }
  const verdict: CredentialVerdict = provider.verify ? await provider.verify(real, ctx.fetch) : 'unknown'
  const base = { userId, agent, sandboxId: ctx.sandboxId, path: ctx.path, now }
  if (verdict !== 'invalid') {
    await audit(db, { ...base, action: 'kept', reason: verdict === 'valid' ? 'check_passed' : 'check_inconclusive' })
    return 'kept'
  }
  await markAgentCredentialRevoked(db, userId, agent, now)
  await audit(db, { ...base, action: 'revoked', reason: 'provider_401_confirmed_by_check' })
  return 'revoked'
}
