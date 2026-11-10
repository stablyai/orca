// Cloud setup sessions (NP-4 N1): one browser tab that chains sign-in -> team -> plan/trial ->
// (Checkout only when needed) -> GitHub App install, skipping steps that are already done.
//
// Who talks to it:
// - Desktop (billing JWT): creates a session after sign-in and polls it. The session belongs to
//   that Orca user; nobody else can read it.
// - Setup pages on Orca Cloud auth (MEMBERSHIP_SYNC_TOKEN): redeem the one-time browser ticket,
//   read the session, bind the team, open Checkout, ask for the GitHub install URL, record errors.
//   Auth asserts the browser's user; every call re-checks it against the session's user.
// - Control plane (CONTROL_PLANE_TOKEN): flips the GitHub step when an installation binds.
//
// Steps are derived on every read (entitlement, trial, GitHub state), so the session never caches
// a plan state that billing could contradict.
import { z } from 'zod'
import type { BillingCaller } from './auth'
import { createCheckout, OPEN_STATUSES } from './checkout'
import type { TrialPort } from './cloud-setup-trial'
import { computeEntitlement } from './entitlements'
import type { Env } from './env'
import type { MembershipSource } from './membership'
import { BILLING_INTERVALS, type BillingInterval } from './plans'
import type { StripeClient } from './stripe'
import { currentSubscription } from './store'
import { setupPageUrl } from './cloud-setup-urls'

export const SETUP_SESSION_ID = /^cs_[A-Za-z0-9_-]{22}$/
const ORCA_ID = /^[A-Za-z0-9_.:-]{1,128}$/

export const SETUP_STEPS = ['team', 'plan', 'github'] as const
export type SetupNeed = (typeof SETUP_STEPS)[number]

/** Sessions live two hours; no progress for 15 minutes reads as "Setup didn't finish". */
export const SESSION_TTL_MS = 2 * 3600_000
export const IDLE_TIMEOUT_MS = 15 * 60_000
const TICKET_TTL_MS = 10 * 60_000
/** Per user: enough for retries and several projects, too few to farm sessions. */
const MAX_SESSIONS_PER_HOUR = 20

export const SETUP_ERROR_KINDS = [
  'timed_out',
  'checkout_canceled',
  'bank_step',
  'trial_unavailable',
  'team_create_failed',
  'wrong_account'
] as const
export type SetupErrorKind = (typeof SETUP_ERROR_KINDS)[number]

export type SetupStepState = 'done' | 'needed' | 'active' | 'pending' | 'failed' | 'optional'
export type SetupStep = { id: 'account' | 'team' | 'plan' | 'github'; state: SetupStepState; detail?: string }

export type SetupSessionRow = {
  id: string
  user_id: string
  account_id: string | null
  team_name: string | null
  team_created: number
  repo: string | null
  needs: string
  device: string | null
  billing_interval: string | null
  checkout_state: string | null
  github_state: string | null
  error_kind: string | null
  error_detail: string | null
  ticket_hash: string | null
  ticket_expires_at: number | null
  finished_at: number | null
  created_at: number
  updated_at: number
  expires_at: number
}

export type SetupSessionView = {
  id: string
  steps: SetupStep[]
  team: { orgId: string; name: string | null; created: boolean } | null
  trial: { includedSeconds: number; usedSeconds: number; exhausted: boolean } | null
  /** What the plan step rests on once done. */
  plan: 'subscription' | 'trial' | null
  repo: string | null
  finished: boolean
  error: { kind: SetupErrorKind; detail?: string } | null
  expiresAt: number
}

/** Normalizes a GitHub repository URL to https://github.com/<owner>/<repo> (lower case). */
export function normalizeRepo(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }
  const trimmed = value.trim().replace(/\/+$/, '').replace(/\.git$/i, '')
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/i.exec(trimmed) ??
    /^git@github\.com:([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/i.exec(trimmed)
  return match ? `https://github.com/${match[1]}/${match[2]}`.toLowerCase() : null
}

export function repoOwner(repo: string | null): string | null {
  return repo ? (/^https:\/\/github\.com\/([^/]+)\//.exec(repo)?.[1] ?? null) : null
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomToken(bytes: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function newSetupSessionId(): string {
  // 16 random bytes -> 22 base64url characters.
  return `cs_${randomToken(16)}`
}

function parseNeeds(row: SetupSessionRow): Set<SetupNeed> {
  try {
    const parsed = z.array(z.enum(SETUP_STEPS)).safeParse(JSON.parse(row.needs))
    return new Set(parsed.success ? parsed.data : [])
  } catch {
    return new Set()
  }
}

export const CreateSetupSessionSchema = z
  .object({
    repo: z.string().max(300).optional(),
    needs: z.array(z.enum(SETUP_STEPS)).max(3).default(['team', 'plan']),
    device: z.string().trim().min(1).max(80).optional(),
    // The desktop's active team is the session's team unless it asks to choose ('team' in needs).
    useActiveTeam: z.boolean().default(true)
  })
  .strict()

export type CreateSetupSessionResult =
  | { ok: true; id: string; url: string; expiresAt: number }
  | { ok: false; status: number; error: string }

export async function createSetupSession(
  env: Env,
  caller: BillingCaller,
  body: z.infer<typeof CreateSetupSessionSchema>,
  now: number
): Promise<CreateSetupSessionResult> {
  const recent = await env.BILLING_DB.prepare(
    'SELECT COUNT(*) AS n FROM cloud_setup_sessions WHERE user_id = ?1 AND created_at > ?2'
  )
    .bind(caller.userId, now - 3600_000)
    .first<{ n: number }>()
  if ((recent?.n ?? 0) >= MAX_SESSIONS_PER_HOUR) {
    return { ok: false, status: 429, error: 'rate_limited' }
  }
  const repo = normalizeRepo(body.repo)
  if (body.repo && !repo) {
    return { ok: false, status: 400, error: 'invalid_repo' }
  }
  const needs = new Set<SetupNeed>(body.needs)
  if (needs.has('github') && !repo) {
    needs.delete('github')
  }
  // O1: setup never puts a plan or a trial on a personal account, so a user: caller always gets a
  // team step; an org caller keeps its active team unless it asked to choose.
  const orgAccount = caller.accountId.startsWith('org:') ? caller.accountId : null
  const keepTeam = orgAccount !== null && body.useActiveTeam && !needs.has('team')
  if (!keepTeam) {
    needs.add('team')
  }
  const id = newSetupSessionId()
  const ticket = randomToken(32)
  const expiresAt = now + SESSION_TTL_MS
  await env.BILLING_DB.prepare(
    `INSERT INTO cloud_setup_sessions (id, user_id, account_id, repo, needs, device, ticket_hash,
       ticket_expires_at, created_at, updated_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10)`
  )
    .bind(
      id,
      caller.userId,
      keepTeam ? orgAccount : null,
      repo,
      JSON.stringify([...needs]),
      body.device ?? null,
      await sha256Hex(ticket),
      now + TICKET_TTL_MS,
      now,
      expiresAt
    )
    .run()
  return { ok: true, id, url: setupPageUrl(env, '/start', { session: id, ticket }), expiresAt }
}

/** "Copy setup link": a fresh one-time ticket for another browser (the old one is replaced). */
export async function reissueSetupTicket(
  env: Env,
  caller: BillingCaller,
  id: string,
  now: number
): Promise<{ url: string } | null> {
  const row = await loadSetupSession(env, id, now)
  if (!row || row.user_id !== caller.userId || row.finished_at !== null) {
    return null
  }
  const ticket = randomToken(32)
  await touch(env, id, { ticket_hash: await sha256Hex(ticket), ticket_expires_at: now + TICKET_TTL_MS }, now)
  return { url: setupPageUrl(env, '/start', { session: id, ticket }) }
}

export async function loadSetupSession(env: Env, id: string, now: number): Promise<SetupSessionRow | null> {
  if (!SETUP_SESSION_ID.test(id)) {
    return null
  }
  const row = await env.BILLING_DB.prepare('SELECT * FROM cloud_setup_sessions WHERE id = ?1')
    .bind(id)
    .first<SetupSessionRow>()
  return row && row.expires_at > now ? row : null
}

async function touch(env: Env, id: string, fields: Record<string, string | number | null>, now: number): Promise<void> {
  const keys = Object.keys(fields)
  const sets = keys.map((key, index) => `${key} = ?${index + 2}`)
  await env.BILLING_DB.prepare(
    `UPDATE cloud_setup_sessions SET ${[...sets, `updated_at = ?${keys.length + 2}`].join(', ')} WHERE id = ?1`
  )
    .bind(id, ...keys.map((key) => fields[key] ?? null), now)
    .run()
}

/** The account's plan state as setup sees it: a live subscription, a usable trial, or neither. */
async function planState(
  env: Env,
  trial: TrialPort,
  accountId: string,
  now: number
): Promise<{ plan: 'subscription' | 'trial' | null; trial: SetupSessionView['trial'] }> {
  const subscription = await currentSubscription(env.BILLING_DB, accountId)
  if (subscription && OPEN_STATUSES.has(subscription.status)) {
    const entitlement = await computeEntitlement(env, accountId, now)
    // past_due etc. still count as "has a plan": the composer shows the payment state, not setup.
    return { plan: entitlement.plan ? 'subscription' : null, trial: null }
  }
  const current = await trial.current(env, accountId, now)
  return { plan: current && !current.exhausted ? 'trial' : null, trial: current }
}

export async function setupSessionView(
  env: Env,
  trial: TrialPort,
  row: SetupSessionRow,
  now: number
): Promise<SetupSessionView> {
  const needs = parseNeeds(row)
  const plan = row.account_id ? await planState(env, trial, row.account_id, now) : { plan: null, trial: null }
  const done = {
    team: row.account_id !== null,
    plan: plan.plan !== null || !needs.has('plan'),
    github: row.github_state === 'done' || !needs.has('github')
  }
  const steps: SetupStep[] = [{ id: 'account', state: 'done' }]
  let activeTaken = false
  const push = (id: 'team' | 'plan' | 'github', isDone: boolean, detail?: string) => {
    if (id !== 'team' && !needs.has(id) && !isDone) {
      return
    }
    if (isDone) {
      steps.push({ id, state: 'done', ...(detail ? { detail } : {}) })
      return
    }
    const state: SetupStepState = activeTaken ? 'pending' : 'active'
    activeTaken = true
    steps.push({ id, state, ...(detail ? { detail } : {}) })
  }
  push('team', done.team, row.team_name ?? undefined)
  if (needs.has('plan') || plan.plan) {
    push('plan', done.plan, plan.plan ?? (row.checkout_state === 'open' ? 'checkout' : undefined))
  }
  if (needs.has('github')) {
    push('github', done.github, row.github_state === 'pending' ? 'requested' : undefined)
  }
  const finished = steps.every((step) => step.state === 'done')
  if (finished && row.finished_at === null) {
    await touch(env, row.id, { finished_at: now, error_kind: null, error_detail: null }, now)
  }
  let error: SetupSessionView['error'] = null
  if (!finished) {
    if (row.error_kind && (SETUP_ERROR_KINDS as readonly string[]).includes(row.error_kind)) {
      error = { kind: row.error_kind as SetupErrorKind, ...(row.error_detail ? { detail: row.error_detail } : {}) }
    } else if (now - row.updated_at > IDLE_TIMEOUT_MS && row.github_state !== 'pending') {
      // An owner approval on GitHub can take longer; everything else has stalled.
      error = { kind: 'timed_out' }
    }
  }
  // A failed step reads as failed in the tracker; the rest keep their state.
  if (error && error.kind !== 'timed_out') {
    const failing = error.kind === 'team_create_failed' || error.kind === 'wrong_account' ? 'team' : 'plan'
    const step = steps.find((candidate) => candidate.id === failing)
    if (step && step.state !== 'done') {
      step.state = 'failed'
    }
  }
  return {
    id: row.id,
    steps,
    team: row.account_id
      ? { orgId: row.account_id.slice('org:'.length), name: row.team_name, created: row.team_created === 1 }
      : null,
    trial: plan.trial,
    plan: plan.plan,
    repo: row.repo,
    finished,
    error,
    expiresAt: row.expires_at
  }
}

// ---- Internal: setup pages on Orca Cloud auth -------------------------------------------------

const UserSchema = z.string().regex(ORCA_ID)

export const RedeemSchema = z.object({ sessionId: z.string().regex(SETUP_SESSION_ID), ticket: z.string().min(20).max(100) }).strict()

/** One-time: the ticket from the desktop's URL becomes the browser's proof of this session's user. */
export async function redeemSetupTicket(
  env: Env,
  body: z.infer<typeof RedeemSchema>,
  now: number
): Promise<{ userId: string } | null> {
  const row = await loadSetupSession(env, body.sessionId, now)
  if (!row || !row.ticket_hash || (row.ticket_expires_at ?? 0) <= now) {
    return null
  }
  if (row.ticket_hash !== (await sha256Hex(body.ticket))) {
    return null
  }
  // Clear it in the same statement that checks it, so two tabs can't both redeem.
  const result = await env.BILLING_DB.prepare(
    'UPDATE cloud_setup_sessions SET ticket_hash = NULL, ticket_expires_at = NULL, updated_at = ?3 WHERE id = ?1 AND ticket_hash = ?2'
  )
    .bind(row.id, row.ticket_hash, now)
    .run()
  if ((result.meta as { changes?: number }).changes === 0) {
    return null
  }
  return { userId: row.user_id }
}

export const InternalReadSchema = z.object({ userId: UserSchema }).strict()

export type InternalSetupSession = SetupSessionView & {
  needs: SetupNeed[]
  device: string | null
  interval: BillingInterval | null
  checkoutState: string | null
  githubState: string | null
  /** For the plan page: whether this team can still get its trial (granted when the team binds). */
  ownerHint: string | null
}

export async function readSetupSessionForPages(
  env: Env,
  trial: TrialPort,
  id: string,
  userId: string,
  now: number
): Promise<InternalSetupSession | null> {
  const row = await loadSetupSession(env, id, now)
  if (!row || row.user_id !== userId) {
    return null
  }
  const view = await setupSessionView(env, trial, row, now)
  return {
    ...view,
    needs: [...parseNeeds(row)],
    device: row.device,
    interval: (BILLING_INTERVALS as readonly string[]).includes(row.billing_interval ?? '')
      ? (row.billing_interval as BillingInterval)
      : null,
    checkoutState: row.checkout_state,
    githubState: row.github_state,
    ownerHint: repoOwner(row.repo)
  }
}

export const TeamPlansSchema = z
  .object({ userId: UserSchema, orgIds: z.array(z.string().regex(ORCA_ID)).max(50) })
  .strict()

/** A3: which of the user's teams already have a plan or a usable trial (that team is preselected). */
export async function setupTeamPlans(
  env: Env,
  trial: TrialPort,
  id: string,
  body: z.infer<typeof TeamPlansSchema>,
  now: number
): Promise<Record<string, 'subscription' | 'trial' | 'trial_used_up' | null> | null> {
  const row = await loadSetupSession(env, id, now)
  if (!row || row.user_id !== body.userId) {
    return null
  }
  const entries = await Promise.all(
    body.orgIds.map(async (orgId) => {
      const state = await planState(env, trial, `org:${orgId}`, now)
      return [orgId, state.plan ?? (state.trial?.exhausted ? 'trial_used_up' : null)] as const
    })
  )
  return Object.fromEntries(entries)
}

export const BindTeamSchema = z
  .object({
    userId: UserSchema,
    orgId: z.string().regex(ORCA_ID),
    name: z.string().trim().min(1).max(120),
    created: z.boolean().default(false),
    // Trial abuse keys (N11), forwarded from the page's request and the user's identity.
    email: z.string().email().max(320).optional(),
    emailVerified: z.boolean().optional(),
    githubUserId: z.number().int().positive().optional(),
    githubOwnerId: z.number().int().positive().optional(),
    ip: z.string().max(64).optional()
  })
  .strict()

/**
 * Binds the session to a team (chosen, created, or renamed). A team that has no plan gets the
 * trial now if it can; otherwise the plan step stays and the pages offer T3 + Checkout.
 */
export async function bindSetupTeam(
  env: Env,
  trial: TrialPort,
  id: string,
  body: z.infer<typeof BindTeamSchema>,
  now: number
): Promise<{ ok: true; trial: 'granted' | 'unavailable' | 'not_needed' } | { ok: false; status: number; error: string }> {
  const row = await loadSetupSession(env, id, now)
  if (!row || row.user_id !== body.userId) {
    return { ok: false, status: 404, error: 'not_found' }
  }
  const accountId = `org:${body.orgId}`
  // Once bound, only a rename of the same team is accepted; a different team needs a new session.
  if (row.account_id && row.account_id !== accountId) {
    return { ok: false, status: 409, error: 'team_already_chosen' }
  }
  await touch(
    env,
    id,
    {
      account_id: accountId,
      team_name: body.name,
      team_created: body.created || row.team_created === 1 ? 1 : 0,
      error_kind: null,
      error_detail: null
    },
    now
  )
  const state = await planState(env, trial, accountId, now)
  if (state.plan !== null || !parseNeeds(row).has('plan')) {
    return { ok: true, trial: 'not_needed' }
  }
  if (state.trial) {
    // Had a trial and used it up: Checkout.
    return { ok: true, trial: 'unavailable' }
  }
  const granted = await trial.grant(
    env,
    {
      accountId,
      userId: body.userId,
      ...(body.email ? { email: body.email } : {}),
      ...(body.emailVerified !== undefined ? { emailVerified: body.emailVerified } : {}),
      ...(body.githubUserId ? { githubUserId: body.githubUserId } : {}),
      ...(body.githubOwnerId ? { githubOwnerId: body.githubOwnerId } : {}),
      ...(body.ip ? { ip: body.ip } : {})
    },
    now
  )
  return { ok: true, trial: granted.ok ? 'granted' : 'unavailable' }
}

export const SetupErrorSchema = z
  .object({
    userId: UserSchema,
    kind: z.enum(SETUP_ERROR_KINDS).nullable(),
    detail: z.string().max(320).optional()
  })
  .strict()

export async function recordSetupError(
  env: Env,
  id: string,
  body: z.infer<typeof SetupErrorSchema>,
  now: number
): Promise<boolean> {
  const row = await loadSetupSession(env, id, now)
  if (!row || row.user_id !== body.userId) {
    return false
  }
  await touch(
    env,
    id,
    {
      error_kind: body.kind,
      error_detail: body.kind ? (body.detail ?? null) : null,
      ...(body.kind === 'checkout_canceled' ? { checkout_state: 'canceled' } : {})
    },
    now
  )
  return true
}

export const SetupCheckoutSchema = z
  .object({
    userId: UserSchema,
    orgRole: z.enum(['owner', 'admin', 'member']),
    email: z.string().email().max(320).optional(),
    interval: z.enum(BILLING_INTERVALS)
  })
  .strict()

/** T3 -> Stripe: Checkout for the session's team, returning to the setup pages (never a user:). */
export async function createSetupCheckout(
  env: Env,
  stripe: StripeClient,
  id: string,
  body: z.infer<typeof SetupCheckoutSchema>,
  now: number,
  membership: MembershipSource
): Promise<{ ok: true; url: string } | { ok: false; status: number; error: string }> {
  const row = await loadSetupSession(env, id, now)
  if (!row || row.user_id !== body.userId) {
    return { ok: false, status: 404, error: 'not_found' }
  }
  if (!row.account_id) {
    return { ok: false, status: 409, error: 'team_required' }
  }
  const caller: BillingCaller = {
    userId: body.userId,
    accountId: row.account_id,
    canManage: body.orgRole === 'owner' || body.orgRole === 'admin',
    ...(body.email ? { email: body.email } : {})
  }
  const outcome = await createCheckout(
    env,
    stripe,
    caller,
    { plan: 'team', interval: body.interval, seats: 1 },
    now,
    membership,
    { setupSessionId: id }
  )
  if (outcome.ok) {
    await touch(env, id, { billing_interval: body.interval, checkout_state: 'open', error_kind: null, error_detail: null }, now)
  }
  return outcome
}

export const GithubInstallSchema = z
  .object({
    userId: UserSchema,
    // Set only after auth verified a live GitHub sign-in token for this user (N5).
    githubUserId: z.number().int().positive().optional(),
    githubLogin: z.string().regex(/^[A-Za-z0-9-]{1,39}$/).optional()
  })
  .strict()

const InstallUrlResponse = z.looseObject({
  access: z.enum(['public', 'granted', 'missing', 'requested']),
  url: z.string().url().nullable().optional()
})

/** Asks the control plane how this session's repository is reachable and, if not, for the install URL. */
export async function setupGithubInstall(
  env: Env,
  id: string,
  body: z.infer<typeof GithubInstallSchema>,
  now: number,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: true; access: string; url: string | null } | { ok: false; status: number; error: string }> {
  const row = await loadSetupSession(env, id, now)
  if (!row || row.user_id !== body.userId) {
    return { ok: false, status: 404, error: 'not_found' }
  }
  if (!row.repo || !row.account_id) {
    return { ok: false, status: 409, error: row.repo ? 'team_required' : 'no_repo' }
  }
  if (!env.SANDBOX_CONTROL_URL) {
    return { ok: false, status: 503, error: 'github_unavailable' }
  }
  const url = new URL('/v1/internal/github/install-url', env.SANDBOX_CONTROL_URL)
  url.searchParams.set('accountId', row.account_id)
  url.searchParams.set('userId', row.user_id)
  url.searchParams.set('repo', row.repo)
  url.searchParams.set('session', row.id)
  if (body.githubUserId && body.githubLogin) {
    url.searchParams.set('githubUserId', String(body.githubUserId))
    url.searchParams.set('githubLogin', body.githubLogin)
  }
  const token = (env.CONTROL_PLANE_TOKEN ?? '').split(',')[0]?.trim() ?? ''
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(8000)
  })
  const parsed = InstallUrlResponse.safeParse(await response.json().catch(() => null))
  if (!response.ok || !parsed.success) {
    return { ok: false, status: 502, error: 'github_unavailable' }
  }
  const access = parsed.data.access
  if (access === 'public' || access === 'granted') {
    await touch(env, id, { github_state: 'done' }, now)
  } else if (access === 'requested') {
    await touch(env, id, { github_state: 'pending' }, now)
  }
  return { ok: true, access, url: access === 'missing' ? (parsed.data.url ?? null) : null }
}

// ---- Internal: control plane ------------------------------------------------------------------

export const GithubEventSchema = z
  .object({
    sessionId: z.string().regex(SETUP_SESSION_ID).optional(),
    accountId: z.string().regex(ORCA_ID),
    repo: z.string().max(300),
    state: z.enum(['done', 'pending'])
  })
  .strict()

/** An installation bound (or an owner approval was requested): flip matching open sessions. */
export async function recordGithubEvent(
  env: Env,
  body: z.infer<typeof GithubEventSchema>,
  now: number
): Promise<{ matched: number }> {
  const repo = normalizeRepo(body.repo)
  if (!repo) {
    return { matched: 0 }
  }
  // 'pending' never overwrites 'done' (a late request echo after the bind).
  const guard = body.state === 'pending' ? "AND (github_state IS NULL OR github_state <> 'done')" : ''
  const result = body.sessionId
    ? await env.BILLING_DB.prepare(
        `UPDATE cloud_setup_sessions SET github_state = ?1, updated_at = ?2
         WHERE id = ?3 AND account_id = ?4 AND repo = ?5 AND expires_at > ?2 ${guard}`
      )
        .bind(body.state, now, body.sessionId, body.accountId, repo)
        .run()
    : await env.BILLING_DB.prepare(
        `UPDATE cloud_setup_sessions SET github_state = ?1, updated_at = ?2
         WHERE account_id = ?3 AND repo = ?4 AND expires_at > ?2 AND finished_at IS NULL ${guard}`
      )
        .bind(body.state, now, body.accountId, repo)
        .run()
  return { matched: (result.meta as { changes?: number }).changes ?? 0 }
}
