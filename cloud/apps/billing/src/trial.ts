// One-time trial (spec N11, decision O7): 2 sandbox hours per new team, no card, no Stripe.
// - Granted explicitly (POST /v1/billing/trial, or grantTrial() from the setup session), never as a
//   side effect of reading entitlements, and only to a team (org:) that has never had a
//   subscription or a trial.
// - Abuse limits: once per team, per Orca user, per verified email (normalized), per GitHub user id
//   and per GitHub owner id; disposable email domains are refused; grants are rate limited per IP.
//   Keys are stored as SHA-256 hashes (trial_claims), never raw emails or IPs.
// - A GitHub binding learned after the grant (POST /v1/internal/trial/github) that collides with
//   another team's trial revokes this one (trial_unavailable).
// - Metered through usage_events like plan usage (segments with no subscription count against the
//   trial). No overage, 1 sandbox at a time. Any subscription row ends the trial for good.
import type { Env } from './env'
import { loadCatalog, planVersion, trialPlan } from './catalog'
import { entitlementsMode } from './entitlements-mode'

// Legacy terms (ENTITLEMENTS_MODE off/shadow). With 'on' the trial plan in the D1 catalog decides
// (catalog/catalog.json "trial"), and a granted trial keeps the hours it was granted with.
export const TRIAL_INCLUDED_SECONDS = 2 * 3600
export const TRIAL_MAX_CONCURRENT_SANDBOXES = 1

/** Seconds a trial granted now includes, or null when the catalog offers no trial. */
export async function trialIncludedSeconds(env: Pick<Env, 'BILLING_DB' | 'ENTITLEMENTS_MODE'>, now: number): Promise<number | null> {
  if (entitlementsMode(env) !== 'on') {
    return TRIAL_INCLUDED_SECONDS
  }
  const plan = trialPlan(await loadCatalog(env.BILLING_DB, now))
  const hours = plan ? planVersion(plan, plan.currentVersion).entitlements.sandbox_hours_lifetime?.value : undefined
  return typeof hours === 'number' && hours > 0 ? Math.round(hours * 3600) : null
}
/** Trial grants allowed from one IP address per rolling day. */
export const TRIAL_GRANTS_PER_IP_PER_DAY = 3
const DAY_MS = 24 * 3600 * 1000

// Small built-in list of the most common throwaway-mail providers. Not exhaustive by design: it
// stops casual repeat sign-ups; the per-user, per-email and per-GitHub keys do the rest.
export const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  '10minutemail.com',
  '20minutemail.com',
  'discard.email',
  'dispostable.com',
  'emailondeck.com',
  'fakeinbox.com',
  'getairmail.com',
  'getnada.com',
  'guerrillamail.com',
  'guerrillamail.net',
  'guerrillamailblock.com',
  'maildrop.cc',
  'mailinator.com',
  'mailnesia.com',
  'mintemail.com',
  'mohmal.com',
  'moakt.com',
  'mytemp.email',
  'sharklasers.com',
  'spamgourmet.com',
  'temp-mail.org',
  'tempail.com',
  'tempmail.com',
  'tempmail.dev',
  'tempmailo.com',
  'tempr.email',
  'throwawaymail.com',
  'trashmail.com',
  'yopmail.com',
  'yopmail.net'
])

export type TrialRow = {
  account_id: string
  granted_at: number
  included_seconds: number
  used_seconds: number
  exhausted_at: number | null
  granted_by_user: string
  github_owner_id: string | null
  github_user_id: string | null
  revoked_at: number | null
  revoked_reason: string | null
}

/** What the entitlement carries while a trial is the account's plan. */
export type TrialState = {
  includedSeconds: number
  usedSeconds: number
  remainingSeconds: number
  exhausted: boolean
  grantedAt: number
}

export type TrialInput = {
  accountId: string
  userId: string
  email?: string
  /** From the auth token; false refuses the trial. Absent: auth only signs in confirmed emails. */
  emailVerified?: boolean
  githubUserId?: string
  githubOwnerId?: string
  /** cf-connecting-ip of the request that asked for the grant. */
  ip?: string
}

export type TrialRefusal = 'trial_unavailable' | 'team_required'
export type GrantOutcome = { ok: true; trial: TrialState; granted: boolean } | { ok: false; reason: TrialRefusal }

type ClaimKind = 'user' | 'email' | 'github_user' | 'github_owner' | 'ip'


/** Lowercase, strip +tags, and Gmail's ignored dots, so one inbox is one key. */
export function normalizeEmail(email: string): { address: string; domain: string } | null {
  const at = email.trim().toLowerCase().lastIndexOf('@')
  if (at <= 0) {
    return null
  }
  const lower = email.trim().toLowerCase()
  let local = lower.slice(0, at).split('+')[0] ?? ''
  let domain = lower.slice(at + 1)
  if (domain === 'googlemail.com') {
    domain = 'gmail.com'
  }
  if (domain === 'gmail.com') {
    local = local.replaceAll('.', '')
  }
  if (!local || !domain.includes('.')) {
    return null
  }
  return { address: `${local}@${domain}`, domain }
}

export function isDisposableEmailDomain(domain: string): boolean {
  const parts = domain.toLowerCase().split('.')
  // Also catch subdomains (x.mailinator.com).
  for (let i = 0; i < parts.length - 1; i++) {
    if (DISPOSABLE_EMAIL_DOMAINS.has(parts.slice(i).join('.'))) {
      return true
    }
  }
  return false
}

async function hashKey(kind: ClaimKind, value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`orca-trial:${kind}:${value}`))
  )
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const GITHUB_ID = /^\d{1,20}$/

/** Trials belong to teams (O1): 'org:<id>', or 'dev:org:<id>' for dev operator accounts. */
export function isTeamAccount(accountId: string): boolean {
  return /^(dev:)?org:/.test(accountId)
}

async function claimKeys(input: TrialInput): Promise<Array<{ kind: ClaimKind; hash: string }> | null> {
  const keys: Array<{ kind: ClaimKind; hash: string }> = [{ kind: 'user', hash: await hashKey('user', input.userId) }]
  if (input.emailVerified === false || !input.email) {
    return null
  }
  const email = normalizeEmail(input.email)
  if (!email || isDisposableEmailDomain(email.domain)) {
    return null
  }
  keys.push({ kind: 'email', hash: await hashKey('email', email.address) })
  if (input.githubUserId && GITHUB_ID.test(input.githubUserId)) {
    keys.push({ kind: 'github_user', hash: await hashKey('github_user', input.githubUserId) })
  }
  if (input.githubOwnerId && GITHUB_ID.test(input.githubOwnerId)) {
    keys.push({ kind: 'github_owner', hash: await hashKey('github_owner', input.githubOwnerId) })
  }
  return keys
}

export async function trialRow(db: D1Database, accountId: string): Promise<TrialRow | null> {
  return db.prepare('SELECT * FROM trials WHERE account_id = ?1').bind(accountId).first<TrialRow>()
}

export function trialState(row: TrialRow): TrialState {
  const remaining = Math.max(0, row.included_seconds - row.used_seconds)
  return {
    includedSeconds: row.included_seconds,
    usedSeconds: row.used_seconds,
    remainingSeconds: remaining,
    exhausted: remaining === 0 || row.exhausted_at !== null,
    grantedAt: row.granted_at
  }
}

async function everSubscribed(db: D1Database, accountId: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS one FROM subscriptions WHERE account_id = ?1 LIMIT 1').bind(accountId).first()
  return row !== null
}

/** A key some other account's granted trial already used. */
async function keyTaken(db: D1Database, keys: Array<{ kind: ClaimKind; hash: string }>, accountId: string): Promise<boolean> {
  for (const key of keys) {
    const row = await db
      .prepare('SELECT 1 AS one FROM trial_claims WHERE kind = ?1 AND key_hash = ?2 AND account_id <> ?3 AND granted = 1 LIMIT 1')
      .bind(key.kind, key.hash, accountId)
      .first()
    if (row) {
      return true
    }
  }
  return false
}

/** GitHub keys a binding recorded on this account before the trial was asked for. */
async function boundGithubKeys(db: D1Database, accountId: string): Promise<Array<{ kind: ClaimKind; hash: string }>> {
  const { results } = await db
    .prepare("SELECT kind, key_hash FROM trial_claims WHERE account_id = ?1 AND kind IN ('github_user', 'github_owner')")
    .bind(accountId)
    .all<{ kind: ClaimKind; key_hash: string }>()
  return results.map((row) => ({ kind: row.kind, hash: row.key_hash }))
}

async function recentIpGrants(db: D1Database, ipHash: string, now: number): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM trial_claims WHERE kind = 'ip' AND key_hash = ?1 AND created_at > ?2")
    .bind(ipHash, now - DAY_MS)
    .first<{ n: number }>()
  return row?.n ?? 0
}

/**
 * Whether this caller could get a trial for `input.accountId` right now (read only). A personal
 * account (user:) is checked as the user who will get one once setup creates their team.
 */
export async function trialOffer(
  env: Pick<Env, 'BILLING_DB' | 'ENTITLEMENTS_MODE'>,
  input: TrialInput,
  now: number
): Promise<{ includedSeconds: number } | null> {
  const db = env.BILLING_DB
  const offered = await trialIncludedSeconds(env, now)
  if (offered === null) {
    return null
  }
  if ((await trialRow(db, input.accountId)) || (await everSubscribed(db, input.accountId))) {
    return null
  }
  const keys = await claimKeys(input)
  if (!keys) {
    return null
  }
  const all = isTeamAccount(input.accountId) ? [...keys, ...(await boundGithubKeys(db, input.accountId))] : keys
  if (await keyTaken(db, all, input.accountId)) {
    return null
  }
  return { includedSeconds: offered }
}

/**
 * Grants the team its trial, atomically with every abuse key it consumes. Idempotent: a team that
 * already has a trial gets it back (granted: false). Refusals never say which key matched.
 */
export async function grantTrial(
  env: Pick<Env, 'BILLING_DB' | 'ENTITLEMENTS_MODE'>,
  input: TrialInput,
  now: number
): Promise<GrantOutcome> {
  const db = env.BILLING_DB
  if (!isTeamAccount(input.accountId)) {
    // O1: trials and plans belong to a team; setup creates one first.
    return { ok: false, reason: 'team_required' }
  }
  const existing = await trialRow(db, input.accountId)
  if (existing) {
    return existing.revoked_at === null && !(await everSubscribed(db, input.accountId))
      ? { ok: true, trial: trialState(existing), granted: false }
      : { ok: false, reason: 'trial_unavailable' }
  }
  if (await everSubscribed(db, input.accountId)) {
    return { ok: false, reason: 'trial_unavailable' }
  }
  const keys = await claimKeys(input)
  if (!keys) {
    return { ok: false, reason: 'trial_unavailable' }
  }
  const bound = await boundGithubKeys(db, input.accountId)
  const consumed = [...keys, ...bound.filter((key) => !keys.some((own) => own.kind === key.kind && own.hash === key.hash))]
  const ipHash = input.ip ? await hashKey('ip', input.ip) : null
  if (ipHash && (await recentIpGrants(db, ipHash, now)) >= TRIAL_GRANTS_PER_IP_PER_DAY) {
    return { ok: false, reason: 'trial_unavailable' }
  }
  const included = await trialIncludedSeconds(env, now)
  if (included === null) {
    return { ok: false, reason: 'trial_unavailable' }
  }
  // One transaction: the trial row is inserted only if no key is taken and the account never
  // subscribed (re-checked inside the batch, so two concurrent grants can't share a key), then
  // every key is marked consumed for this account.
  const takenClause = consumed
    .map((_, index) => `EXISTS (SELECT 1 FROM trial_claims WHERE kind = ?${7 + index * 2} AND key_hash = ?${8 + index * 2} AND account_id <> ?1 AND granted = 1)`)
    .join(' OR ')
  const keyParams = consumed.flatMap((key) => [key.kind, key.hash])
  const insertTrial = db
    .prepare(
      `INSERT OR IGNORE INTO trials (account_id, granted_at, included_seconds, used_seconds, granted_by_user, github_owner_id, github_user_id)
       SELECT ?1, ?2, ?3, 0, ?4, ?5, ?6
       WHERE NOT EXISTS (SELECT 1 FROM subscriptions WHERE account_id = ?1)
         AND NOT EXISTS (SELECT 1 FROM trials WHERE account_id = ?1)
         AND NOT (${takenClause})`
    )
    .bind(
      input.accountId,
      now,
      included,
      input.userId,
      input.githubOwnerId && GITHUB_ID.test(input.githubOwnerId) ? input.githubOwnerId : null,
      input.githubUserId && GITHUB_ID.test(input.githubUserId) ? input.githubUserId : null,
      ...keyParams
    )
  const claimRows = [...consumed, ...(ipHash ? [{ kind: 'ip' as const, hash: ipHash }] : [])].map((key) =>
    db
      .prepare(
        `INSERT INTO trial_claims (kind, key_hash, account_id, granted, created_at)
         SELECT ?1, ?2, ?3, 1, ?4 WHERE EXISTS (SELECT 1 FROM trials WHERE account_id = ?3 AND granted_at = ?4 AND granted_by_user = ?5)
         ON CONFLICT (kind, key_hash, account_id) DO UPDATE SET granted = 1`
      )
      .bind(key.kind, key.hash, input.accountId, now, input.userId)
  )
  await db.batch([insertTrial, ...claimRows])
  const row = await trialRow(db, input.accountId)
  if (!row || row.granted_at !== now || row.granted_by_user !== input.userId) {
    // Lost a race to a concurrent grant for the same team (fine: return it) or a key was taken.
    return row && row.revoked_at === null ? { ok: true, trial: trialState(row), granted: false } : { ok: false, reason: 'trial_unavailable' }
  }
  return { ok: true, trial: trialState(row), granted: true }
}

/**
 * Records the GitHub identities a team bound (from the control plane's GitHub App binding). If the
 * team already has a trial and another team's trial used either identity, this trial is revoked.
 */
export async function recordTrialGithub(
  env: Pick<Env, 'BILLING_DB'>,
  input: { accountId: string; githubUserId?: string; githubOwnerId?: string },
  now: number
): Promise<{ revoked: boolean }> {
  const db = env.BILLING_DB
  if (!isTeamAccount(input.accountId)) {
    // Personal accounts never get a trial, so their GitHub bindings aren't trial keys.
    return { revoked: false }
  }
  const keys: Array<{ kind: ClaimKind; hash: string; raw: string }> = []
  if (input.githubUserId && GITHUB_ID.test(input.githubUserId)) {
    keys.push({ kind: 'github_user', hash: await hashKey('github_user', input.githubUserId), raw: input.githubUserId })
  }
  if (input.githubOwnerId && GITHUB_ID.test(input.githubOwnerId)) {
    keys.push({ kind: 'github_owner', hash: await hashKey('github_owner', input.githubOwnerId), raw: input.githubOwnerId })
  }
  if (keys.length === 0) {
    return { revoked: false }
  }
  const trial = await trialRow(db, input.accountId)
  const live = trial !== null && trial.revoked_at === null
  if (live && (await keyTaken(db, keys, input.accountId))) {
    await db
      .prepare("UPDATE trials SET revoked_at = ?2, revoked_reason = 'github_identity_reused' WHERE account_id = ?1 AND revoked_at IS NULL")
      .bind(input.accountId, now)
      .run()
    return { revoked: true }
  }
  await db.batch(
    keys.map((key) =>
      db
        .prepare(
          `INSERT INTO trial_claims (kind, key_hash, account_id, granted, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (kind, key_hash, account_id) DO UPDATE SET granted = MAX(granted, excluded.granted)`
        )
        .bind(key.kind, key.hash, input.accountId, live ? 1 : 0, now)
    )
  )
  if (live) {
    await db
      .prepare(
        'UPDATE trials SET github_user_id = COALESCE(github_user_id, ?2), github_owner_id = COALESCE(github_owner_id, ?3) WHERE account_id = ?1'
      )
      .bind(input.accountId, input.githubUserId ?? null, input.githubOwnerId ?? null)
      .run()
  }
  return { revoked: false }
}

/** Re-totals the trial's usage from usage_events (idempotent; called after each usage report). */
export async function refreshTrialUsage(db: D1Database, accountId: string, now: number): Promise<void> {
  await db
    .prepare(
      `UPDATE trials SET
         used_seconds = (SELECT COALESCE(SUM(weighted_seconds), 0) FROM usage_events
                         WHERE account_id = ?1 AND period_start IS NULL),
         exhausted_at = CASE
           WHEN exhausted_at IS NOT NULL THEN exhausted_at
           WHEN (SELECT COALESCE(SUM(weighted_seconds), 0) FROM usage_events
                 WHERE account_id = ?1 AND period_start IS NULL) >= included_seconds THEN ?2
           ELSE NULL END
       WHERE account_id = ?1`
    )
    .bind(accountId, now)
    .run()
}

/**
 * Generic fixed-window per-IP limiter for unauthenticated or pre-team endpoints (the setup session
 * uses it too). Stores only a hash of the IP. Returns false when over `limit` in `windowMs`.
 */
export async function rateLimitIp(
  env: Pick<Env, 'BILLING_DB'>,
  ip: string | null | undefined,
  scope: string,
  limit: number,
  windowMs: number,
  now: number
): Promise<boolean> {
  if (!ip) {
    return true
  }
  const hash = await hashKey('ip', `${scope}:${ip}`)
  const row = await env.BILLING_DB
    .prepare("SELECT COUNT(*) AS n FROM trial_claims WHERE kind = 'ip' AND key_hash = ?1 AND created_at > ?2")
    .bind(hash, now - windowMs)
    .first<{ n: number }>()
  if ((row?.n ?? 0) >= limit) {
    return false
  }
  await env.BILLING_DB
    .prepare("INSERT OR IGNORE INTO trial_claims (kind, key_hash, account_id, granted, created_at) VALUES ('ip', ?1, ?2, 0, ?3)")
    .bind(hash, `rate:${scope}:${now}:${crypto.randomUUID()}`, now)
    .run()
  return true
}
