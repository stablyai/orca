// A provider 401 on an Orca-account request (the proxy swapped the real credential in) is a signal, not a
// verdict: one transient auth error must not sign a person out of every workspace. The control plane makes
// one cheap server-side auth check with the real credential (no tokens spent). RS-2: that check alone never
// revokes either (it has never been tried against a real OAuth sign-in): a failed check marks the sign-in
// "needs check" (suspect), which stays usable at egress; a LATER real agent request that also gets a 401
// revokes it, and a real request that succeeds (or a passing check) clears it. The desktop can ask for the same check before a
// launch (POST /v1/agent-credentials/claude/verify). Checks are rate-limited per person and agent
// (agent_credentials.checked_at), passes are remembered (verified_at), and every keep or revoke is audited
// (agent_credential_audit).
import type { AccountProvider } from './account-providers'
import {
  agentCredentialSuspectAt,
  clearAgentCredentialSuspect,
  markAgentCredentialRevoked,
  markAgentCredentialSuspect,
  readUsableAgentCredential
} from './agent-credentials'
import type { Keyring } from './secrets-crypto'

/** At most one auth check (and so one revoke) per person and agent per minute. */
export const CREDENTIAL_CHECK_INTERVAL_MS = 60_000
/** A pass this recent answers verify without calling the provider. */
export const CREDENTIAL_VERIFIED_FRESH_MS = 10 * 60_000

export type CredentialVerdict = 'valid' | 'invalid' | 'unknown'
export type CheckOutcome = 'revoked' | 'suspect' | 'kept' | 'skipped'

type CheckContext = {
  db: D1Database
  keyring: Keyring
  provider: Pick<AccountProvider, 'agent' | 'verify'>
  userId: string
  now: number
  fetch: typeof fetch
}

async function audit(
  db: D1Database,
  entry: { userId: string; agent: string; action: 'revoked' | 'suspect' | 'kept'; reason: string; sandboxId: string | null; path: string | null; now: number }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO agent_credential_audit (user_id, agent, action, reason, sandbox_id, upstream_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(entry.userId, entry.agent, entry.action, entry.reason, entry.sandboxId, entry.path ? entry.path.split('?')[0]!.slice(0, 200) : null, entry.now)
    .run()
  console.log(JSON.stringify({ event: `agent_credential_${entry.action}`, agent: entry.agent, reason: entry.reason, sandboxId: entry.sandboxId }))
}

/**
 * One rate-limited auth check. Revokes only on a definite auth failure; a pass is remembered. 'skipped'
 * when another check ran within the minute or the credential isn't usable.
 */
async function checkCredential(
  ctx: CheckContext,
  trigger: { kind: 'egress_401'; sandboxId: string; path: string } | { kind: 'verify' }
): Promise<CheckOutcome> {
  const { db, provider, userId, now } = ctx
  const agent = provider.agent
  // Claim the check slot: a burst of parallel 401s or verify calls makes one check a minute.
  const claimed = await db
    .prepare(
      `UPDATE agent_credentials SET checked_at = ?
       WHERE user_id = ? AND agent = ? AND state = 'active' AND (checked_at IS NULL OR checked_at <= ?)`
    )
    .bind(now, userId, agent, now - CREDENTIAL_CHECK_INTERVAL_MS)
    .run()
  if (!claimed.meta.changes) {
    console.log(JSON.stringify({ event: 'agent_credential_check_skipped', agent, trigger: trigger.kind }))
    return 'skipped'
  }
  const real = await readUsableAgentCredential(db, ctx.keyring, userId, agent, now)
  if (!real) {
    return 'skipped'
  }
  const verdict: CredentialVerdict = provider.verify ? await provider.verify(real, ctx.fetch) : 'unknown'
  const where =
    trigger.kind === 'egress_401'
      ? { sandboxId: trigger.sandboxId, path: trigger.path }
      : { sandboxId: null, path: null }
  const base = { userId, agent, now, ...where }
  if (verdict === 'valid') {
    await db.prepare(`UPDATE agent_credentials SET verified_at = ? WHERE user_id = ? AND agent = ?`).bind(now, userId, agent).run()
    // A passing check clears "needs check".
    await clearAgentCredentialSuspect(db, userId, agent, now)
  }
  if (verdict !== 'invalid') {
    // A pass on a pre-launch verify is routine; a 401 that didn't hold up, or any inconclusive check, is audited.
    if (trigger.kind === 'egress_401' || verdict === 'unknown') {
      const reason = verdict === 'valid' ? 'check_passed' : 'check_inconclusive'
      await audit(db, { ...base, action: 'kept', reason: trigger.kind === 'verify' ? `verify_${reason}` : reason })
    }
    return 'kept'
  }
  // RS-2: the check's auth failure alone never revokes: the sign-in needs a real request to confirm it.
  await markAgentCredentialSuspect(db, userId, agent, now)
  await audit(db, {
    ...base,
    action: 'suspect',
    reason: trigger.kind === 'verify' ? 'verify_check_auth_failure' : 'provider_401_check_auth_failure'
  })
  return 'suspect'
}

/**
 * A real agent request got a 401 with the real credential swapped in. A sign-in already in question (a
 * check failed after an EARLIER 401) is now confirmed dead: revoked. Otherwise one rate-limited check, which
 * at most puts it in question.
 */
export async function handleAccountUnauthorized(
  ctx: CheckContext & { sandboxId: string; path: string }
): Promise<CheckOutcome> {
  const suspectAt = await agentCredentialSuspectAt(ctx.db, ctx.userId, ctx.provider.agent)
  if (suspectAt !== null && ctx.now > suspectAt) {
    await markAgentCredentialRevoked(ctx.db, ctx.userId, ctx.provider.agent, ctx.now)
    await audit(ctx.db, {
      userId: ctx.userId,
      agent: ctx.provider.agent,
      action: 'revoked',
      reason: 'provider_401_after_check_failure',
      sandboxId: ctx.sandboxId,
      path: ctx.path,
      now: ctx.now
    })
    return 'revoked'
  }
  return checkCredential(ctx, { kind: 'egress_401', sandboxId: ctx.sandboxId, path: ctx.path })
}

/** RS-2: a real agent request with the real credential succeeded: a sign-in in question is fine after all. */
export async function handleAccountRequestSucceeded(ctx: {
  db: D1Database
  agent: AccountProvider['agent']
  userId: string
  sandboxId: string
  path: string
  now: number
}): Promise<boolean> {
  const cleared = await clearAgentCredentialSuspect(ctx.db, ctx.userId, ctx.agent, ctx.now)
  if (cleared) {
    await audit(ctx.db, {
      userId: ctx.userId,
      agent: ctx.agent,
      action: 'kept',
      reason: 'request_succeeded_after_check_failure',
      sandboxId: ctx.sandboxId,
      path: ctx.path,
      now: ctx.now
    })
  }
  return cleared
}

/**
 * Pre-launch verify: a pass within CREDENTIAL_VERIFIED_FRESH_MS answers at once; otherwise one check (rate
 * limited). Returns what happened; the caller re-reads the state.
 */
export async function verifyAccountCredential(
  ctx: CheckContext
): Promise<{ outcome: CheckOutcome | 'fresh'; verifiedAt: number | null }> {
  const row = await ctx.db
    .prepare(`SELECT verified_at FROM agent_credentials WHERE user_id = ? AND agent = ?`)
    .bind(ctx.userId, ctx.provider.agent)
    .first<{ verified_at: number | null }>()
  const last = row?.verified_at ?? null
  if (last !== null && ctx.now - last < CREDENTIAL_VERIFIED_FRESH_MS) {
    return { outcome: 'fresh', verifiedAt: last }
  }
  const outcome = await checkCredential(ctx, { kind: 'verify' })
  const after = await ctx.db
    .prepare(`SELECT verified_at FROM agent_credentials WHERE user_id = ? AND agent = ?`)
    .bind(ctx.userId, ctx.provider.agent)
    .first<{ verified_at: number | null }>()
  return { outcome, verifiedAt: after?.verified_at ?? null }
}
