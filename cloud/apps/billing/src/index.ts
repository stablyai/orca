// Orca billing Worker: Stripe Checkout/Portal, Stripe webhooks, entitlements and usage.
//
// Public:
//   GET  /v1/plans                         plan catalog: Stripe prices, entitlements, features (ETag)
// Desktop (Orca Cloud billing JWT):
//   GET  /v1/entitlements                  effective entitlements, access and the grants behind them
//   GET  /v1/billing/entitlements          current plan, hours used/remaining, can-start
//   POST /v1/billing/checkout {plan,interval,seats} -> { url } hosted Stripe Checkout
//   POST /v1/billing/overage {enabled, spendCapCents?} opt in/out of overage, set the cap
//   POST /v1/billing/portal                 -> { url } Stripe Customer Portal
//   POST /v1/billing/team-plans {orgIds}    other teams' plan state ("Switch to <team>"), read-only
//   POST /v1/billing/trial                  claim the team's one-time trial -> entitlement (trial.ts)
//   GET  /v1/billing/usage?utcOffset=       30 days of sandbox hours; top members/sandboxes for admins
// Stripe:
//   POST /v1/stripe/webhook                 signed events
// Sandbox control plane (CONTROL_PLANE_TOKEN):
//   POST /v1/internal/entitlements/check {accountId, machineSize, runningSandboxes}
//   POST /v1/internal/usage {usageId, accountId, sandboxId, machineSize, startedAt, endedAt}
//   GET  /v1/internal/suspensions          accounts whose payment grace expired (suspend running)
//   POST /v1/internal/trial/github {accountId, githubUserId?, githubOwnerId?} GitHub binding -> trial abuse keys
// Orca Cloud auth (MEMBERSHIP_SYNC_TOKEN):
//   POST /v1/internal/seats {accountId, members}
//   POST /v1/internal/cloud-setup/redeem {sessionId, ticket} -> {userId}   one-time browser ticket
//   GET  /v1/internal/cloud-setup/sessions/:id?userId=                     session for the pages
//   POST /v1/internal/cloud-setup/sessions/:id/team {userId, orgId, name, created, ...abuse keys}
//   POST /v1/internal/cloud-setup/sessions/:id/team-plans {userId, orgIds[]} -> {plans}
//   POST /v1/internal/cloud-setup/sessions/:id/checkout {userId, orgRole, email?, interval} -> {url}
//   POST /v1/internal/cloud-setup/sessions/:id/github {userId, githubUserId?, githubLogin?}
//   POST /v1/internal/cloud-setup/sessions/:id/error {userId, kind|null, detail?}
// Cloud setup (desktop billing JWT):
//   POST /v1/cloud-setup/sessions {repo?, needs[], device?, useActiveTeam?} -> {id, url, expiresAt}
//   GET  /v1/cloud-setup/sessions/:id      steps, team, trial, finished, error
//   POST /v1/cloud-setup/sessions/:id/link -> {url}   fresh one-time link ("Copy setup link")
//   GET  /v1/cloud-setup/offers            public: trial hours and Team prices for the setup pages
// Control plane (CONTROL_PLANE_TOKEN):
//   POST /v1/internal/cloud-setup/github {sessionId?, accountId, repo, state}
import { z } from 'zod'
import {
  ADMIN_ACTION_MAX_TOKEN_AGE,
  authenticateControlPlane,
  authenticateDesktop,
  authenticateMembershipSync,
  readBearer
} from './auth'
import { SeatSyncSchema, reconcileSeats, syncSeats } from './seats'
import { MembershipUnavailableError, authMembershipSource, type MembershipSource } from './membership'
import { TeamPlansRequestSchema, authOrgMemberCheck, teamPlans, type OrgMemberCheck } from './team-plans'
import { currentSubscription, graceExpiredAccounts } from './store'
import { CheckoutRequestSchema, createCheckout, createPortal, OPEN_STATUSES } from './checkout'
import { checkStart, computeEntitlement, entitlementsMode } from './entitlements'
import { CatalogUnavailableError, loadCatalog, policyFor } from './catalog'
import { backfillGrants } from './entitlements-backfill'
import { entitlementsView, offersFor, plansView } from './plans-api'
import { reconcile } from './reconcile'
import type { Env } from './env'
import { MACHINE_SIZES, PlanConfigError, planCatalog, publicOffers } from './plans'
import { OverageRequestSchema, updateOverage } from './overage'
import { LiveModeRefusedError, StripeError, createStripeClient, type StripeClient } from './stripe'
import { UsageReportSchema, flushMeterReports, recordUsage, validateSegment } from './usage'
import { handleStripeWebhook } from './webhook'
import { UsageHistoryQuerySchema, usageHistory } from './usage-history'
import { renderReturnPage, returnOutcome } from './return-page'
import {
  BindTeamSchema,
  CreateSetupSessionSchema,
  GithubEventSchema,
  GithubInstallSchema,
  InternalReadSchema,
  RedeemSchema,
  SetupCheckoutSchema,
  SetupErrorSchema,
  TeamPlansSchema,
  bindSetupTeam,
  setupTeamPlans,
  createSetupCheckout,
  createSetupSession,
  loadSetupSession,
  readSetupSessionForPages,
  recordGithubEvent,
  recordSetupError,
  redeemSetupTicket,
  reissueSetupTicket,
  setupGithubInstall,
  setupSessionView
} from './cloud-setup'
import { billingTrialPort, type TrialPort } from './cloud-setup-trial'
import { grantTrial, isTeamAccount, recordTrialGithub, trialOffer, type TrialInput } from './trial'
import type { BillingCaller } from './auth'

// Orca Cloud auth (MEMBERSHIP_SYNC_TOKEN), deleting a team:
//   GET /v1/internal/accounts/:accountId/subscription -> {status, open}
const TEAM_SUBSCRIPTION_PATH = /^\/v1\/internal\/accounts\/(org:[A-Za-z0-9_.:-]{1,150})\/subscription$/
const MAX_JSON_BYTES = 16 * 1024

const StartCheckSchema = z
  .object({
    accountId: z.string().min(1).max(128),
    machineSize: z.enum(MACHINE_SIZES),
    runningSandboxes: z.number().int().min(0).max(10_000),
    // The member starting it and how many they already run (per-member cap; attribution).
    userId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/).optional(),
    runningSandboxesForUser: z.number().int().min(0).max(10_000).optional()
  })
  .strict()

const GITHUB_ID = z.string().regex(/^\d{1,20}$/)
const TrialGithubSchema = z
  .object({ accountId: z.string().min(1).max(128), githubUserId: GITHUB_ID.optional(), githubOwnerId: GITHUB_ID.optional() })
  .strict()

function trialInput(caller: BillingCaller, request: Request): TrialInput {
  return {
    accountId: caller.accountId,
    userId: caller.userId,
    email: caller.email,
    emailVerified: caller.emailVerified,
    githubUserId: caller.githubUserId,
    ip: request.headers.get('cf-connecting-ip') ?? undefined
  }
}

/** The desktop's entitlement body: the account's state plus what this caller is offered. */
async function desktopEntitlement(env: Env, caller: BillingCaller, request: Request, now: number) {
  const entitlement = await computeEntitlement(env, caller.accountId, now, 'desktop')
  const offers = await offersFor(env, now)
  const neverHadPlan = entitlement.reason === 'no_subscription'
  const trial = neverHadPlan ? await trialOffer(env, trialInput(caller, request), now) : null
  // A team that never had a plan but can't get a trial (one already used by this user, email,
  // GitHub identity, or a disposable email) is told so instead of being offered one.
  const reason = neverHadPlan && !trial && isTeamAccount(caller.accountId) ? 'trial_unavailable' : entitlement.reason
  return { ...entitlement, reason, canManageBilling: caller.canManage, offers: { ...offers, trial } }
}

/** Payment grace for the suspension sweep: the plan's policy (one self-serve plan today). */
async function suspensionGraceHours(env: Env, now: number): Promise<number> {
  if (entitlementsMode(env) !== 'on') {
    return planCatalog(env).team.paymentGraceHours
  }
  return policyFor(await loadCatalog(env.BILLING_DB, now), null, null).paymentGraceHours
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text()
  if (text.length > MAX_JSON_BYTES) {
    throw new SyntaxError('too_large')
  }
  return text ? JSON.parse(text) : {}
}

export type Deps = {
  stripe?: StripeClient
  now?: () => number
  membership?: MembershipSource
  orgMember?: OrgMemberCheck
  trial?: TrialPort
  fetch?: typeof fetch
}

const SETUP_SESSION_PATH = /^\/v1\/cloud-setup\/sessions\/(cs_[A-Za-z0-9_-]{22})(\/link)?$/
const INTERNAL_SETUP_PATH = /^\/v1\/internal\/cloud-setup\/sessions\/(cs_[A-Za-z0-9_-]{22})(?:\/(team|team-plans|checkout|github|error))?$/

async function handleCloudSetup(
  request: Request,
  env: Env,
  url: URL,
  now: number,
  deps: { stripe: StripeClient; membership: MembershipSource; trial: TrialPort; fetch: typeof fetch }
): Promise<Response | null> {
  const route = `${request.method} ${url.pathname}`
  if (route === 'GET /v1/cloud-setup/offers') {
    // Public: the setup pages show the trial and prices before anyone has signed in.
    const offered = await deps.trial.offeredSeconds(env, now)
    return json({ ...(await offersFor(env, now)), trial: offered ? { includedSeconds: offered } : null })
  }
  if (route === 'POST /v1/cloud-setup/sessions') {
    const caller = await authenticateDesktop(env, request)
    if (!caller) {
      return json({ error: 'unauthorized' }, 401)
    }
    const body = CreateSetupSessionSchema.safeParse(await readJson(request))
    if (!body.success) {
      return json({ error: 'invalid_request' }, 400)
    }
    const created = await createSetupSession(
      env,
      deps.trial,
      caller,
      body.data,
      now,
      request.headers.get('cf-connecting-ip') ?? undefined
    )
    return created.ok
      ? json({ id: created.id, url: created.url, expiresAt: created.expiresAt }, 201)
      : json({ error: created.error }, created.status)
  }
  const desktopMatch = SETUP_SESSION_PATH.exec(url.pathname)
  if (desktopMatch?.[2] && request.method === 'POST') {
    const caller = await authenticateDesktop(env, request)
    if (!caller) {
      return json({ error: 'unauthorized' }, 401)
    }
    const link = await reissueSetupTicket(env, caller, desktopMatch[1]!, now)
    return link ? json(link) : json({ error: 'not_found' }, 404)
  }
  if (desktopMatch && !desktopMatch[2] && request.method === 'GET') {
    const caller = await authenticateDesktop(env, request)
    if (!caller) {
      return json({ error: 'unauthorized' }, 401)
    }
    const row = await loadSetupSession(env, desktopMatch[1]!, now)
    if (!row || row.user_id !== caller.userId) {
      return json({ error: 'not_found' }, 404)
    }
    return json(await setupSessionView(env, deps.trial, row, now))
  }
  if (route === 'POST /v1/internal/cloud-setup/github') {
    if (!(await authenticateControlPlane(env, request))) {
      return json({ error: 'unauthorized' }, 401)
    }
    const body = GithubEventSchema.safeParse(await readJson(request))
    if (!body.success) {
      return json({ error: 'invalid_request' }, 400)
    }
    return json({ ok: true, ...(await recordGithubEvent(env, body.data, now)) })
  }
  const subscriptionMatch = TEAM_SUBSCRIPTION_PATH.exec(url.pathname)
  if (subscriptionMatch && request.method === 'GET') {
    // Auth, before deleting a team: a team with an open subscription can't be deleted, or Stripe
    // would keep charging an account nobody can reach.
    if (!(await authenticateMembershipSync(env, request))) {
      return json({ error: 'unauthorized' }, 401)
    }
    const subscription = await currentSubscription(env.BILLING_DB, subscriptionMatch[1]!)
    const status = subscription?.status ?? null
    return json({ status, open: status !== null && OPEN_STATUSES.has(status) })
  }
  if (route === 'POST /v1/internal/cloud-setup/redeem') {
    if (!(await authenticateMembershipSync(env, request))) {
      return json({ error: 'unauthorized' }, 401)
    }
    const body = RedeemSchema.safeParse(await readJson(request))
    if (!body.success) {
      return json({ error: 'invalid_request' }, 400)
    }
    const redeemed = await redeemSetupTicket(env, body.data, now)
    return redeemed ? json(redeemed) : json({ error: 'invalid_ticket' }, 404)
  }
  const internalMatch = INTERNAL_SETUP_PATH.exec(url.pathname)
  if (!internalMatch) {
    return null
  }
  if (!(await authenticateMembershipSync(env, request))) {
    return json({ error: 'unauthorized' }, 401)
  }
  const id = internalMatch[1]!
  const action = internalMatch[2]
  if (!action && request.method === 'GET') {
    const query = InternalReadSchema.safeParse({ userId: url.searchParams.get('userId') ?? '' })
    if (!query.success) {
      return json({ error: 'invalid_request' }, 400)
    }
    const session = await readSetupSessionForPages(env, deps.trial, id, query.data.userId, now)
    return session ? json({ ...session, offers: await offersFor(env, now) }) : json({ error: 'not_found' }, 404)
  }
  if (request.method !== 'POST' || !action) {
    return json({ error: 'not_found' }, 404)
  }
  const raw = await readJson(request)
  switch (action) {
    case 'team': {
      const body = BindTeamSchema.safeParse(raw)
      if (!body.success) {
        return json({ error: 'invalid_request' }, 400)
      }
      const bound = await bindSetupTeam(env, deps.trial, id, body.data, now)
      return bound.ok ? json(bound) : json({ error: bound.error }, bound.status)
    }
    case 'team-plans': {
      const body = TeamPlansSchema.safeParse(raw)
      if (!body.success) {
        return json({ error: 'invalid_request' }, 400)
      }
      const plans = await setupTeamPlans(env, deps.trial, id, body.data, now)
      return plans ? json({ plans }) : json({ error: 'not_found' }, 404)
    }
    case 'checkout': {
      const body = SetupCheckoutSchema.safeParse(raw)
      if (!body.success) {
        return json({ error: 'invalid_request' }, 400)
      }
      const outcome = await createSetupCheckout(env, deps.stripe, id, body.data, now, deps.membership)
      return outcome.ok ? json({ url: outcome.url }) : json({ error: outcome.error }, outcome.status)
    }
    case 'github': {
      const body = GithubInstallSchema.safeParse(raw)
      if (!body.success) {
        return json({ error: 'invalid_request' }, 400)
      }
      const outcome = await setupGithubInstall(env, id, body.data, now, deps.fetch)
      return outcome.ok ? json({ access: outcome.access, url: outcome.url }) : json({ error: outcome.error }, outcome.status)
    }
    default: {
      const body = SetupErrorSchema.safeParse(raw)
      if (!body.success) {
        return json({ error: 'invalid_request' }, 400)
      }
      return (await recordSetupError(env, id, body.data, now)) ? json({ ok: true }) : json({ error: 'not_found' }, 404)
    }
  }
}

export async function handleRequest(request: Request, env: Env, ctx: ExecutionContext, deps: Deps = {}): Promise<Response> {
  const url = new URL(request.url)
  const now = deps.now?.() ?? Date.now()
  const stripe = deps.stripe ?? createStripeClient(env)
  const membership = deps.membership ?? authMembershipSource(env)
  const route = `${request.method} ${url.pathname}`
  try {
    if (url.pathname.startsWith('/v1/cloud-setup/') || url.pathname.startsWith('/v1/internal/cloud-setup/')) {
      const handled = await handleCloudSetup(request, env, url, now, {
        stripe,
        membership,
        trial: deps.trial ?? billingTrialPort,
        fetch: deps.fetch ?? fetch
      })
      if (handled) {
        return handled
      }
    }
    switch (route) {
      case 'GET /return':
        // Where Checkout and the Portal send the browser back; hands off to the desktop app.
        return renderReturnPage(returnOutcome(url))

      case 'POST /v1/stripe/webhook':
        return await handleStripeWebhook(env, stripe, request, now)

      case 'GET /v1/plans': {
        // Public catalog (desktop, setup pages, marketing): cacheable, revalidated by ETag.
        const catalog = await loadCatalog(env.BILLING_DB, now)
        const headers = {
          'cache-control': 'public, max-age=300',
          etag: catalog.etag,
          'access-control-allow-origin': '*'
        }
        if (request.headers.get('if-none-match') === catalog.etag) {
          return new Response(null, { status: 304, headers })
        }
        return Response.json(plansView(catalog), { headers })
      }

      case 'GET /v1/entitlements': {
        const caller = await authenticateDesktop(env, request)
        if (!caller) {
          return json({ error: 'unauthorized' }, 401)
        }
        const view = await entitlementsView(env, caller.accountId, caller.canManage, now)
        return Response.json(view, { headers: { 'cache-control': 'private, no-cache' } })
      }

      case 'GET /v1/billing/entitlements': {
        const caller = await authenticateDesktop(env, request)
        if (!caller) {
          return json({ error: 'unauthorized' }, 401)
        }
        return json(await desktopEntitlement(env, caller, request, now))
      }

      case 'GET /v1/billing/usage': {
        // Any member reads the team's daily hours and their own; the breakdown is owners/admins only.
        const caller = await authenticateDesktop(env, request)
        if (!caller) {
          return json({ error: 'unauthorized' }, 401)
        }
        const query = UsageHistoryQuerySchema.safeParse(Object.fromEntries(url.searchParams))
        if (!query.success) {
          return json({ error: 'invalid_request' }, 400)
        }
        return json(await usageHistory(env.BILLING_DB, caller, now, query.data.utcOffset))
      }

      case 'POST /v1/billing/trial': {
        // Any member may start the team's trial the first time they pick Orca Cloud (spec B1).
        const caller = await authenticateDesktop(env, request)
        if (!caller) {
          return json({ error: 'unauthorized' }, 401)
        }
        const outcome = await grantTrial(env, trialInput(caller, request), now)
        if (!outcome.ok) {
          return json({ error: outcome.reason }, outcome.reason === 'team_required' ? 409 : 403)
        }
        return json(await desktopEntitlement(env, caller, request, now))
      }

      case 'POST /v1/internal/trial/github': {
        if (!(await authenticateControlPlane(env, request))) {
          return json({ error: 'unauthorized' }, 401)
        }
        const body = TrialGithubSchema.safeParse(await readJson(request))
        if (!body.success) {
          return json({ error: 'invalid_request' }, 400)
        }
        return json(await recordTrialGithub(env, body.data, now))
      }

      case 'POST /v1/billing/team-plans': {
        // Other teams' plan state for "Switch to <team>" (cloud start B2); read-only, own token.
        const caller = await authenticateDesktop(env, request)
        if (!caller) {
          return json({ error: 'unauthorized' }, 401)
        }
        const body = TeamPlansRequestSchema.safeParse(await readJson(request))
        if (!body.success) {
          return json({ error: 'invalid_request' }, 400)
        }
        // authenticateDesktop accepted the bearer, so it is present.
        const billingToken = readBearer(request.headers.get('authorization'))!
        return json(await teamPlans(env, billingToken, body.data.orgIds, deps.orgMember ?? authOrgMemberCheck(env), now))
      }

      case 'POST /v1/billing/checkout': {
        const caller = await authenticateDesktop(env, request, { maxTokenAge: ADMIN_ACTION_MAX_TOKEN_AGE })
        if (!caller) {
          return json({ error: 'unauthorized' }, 401)
        }
        const body = CheckoutRequestSchema.safeParse(await readJson(request))
        if (!body.success) {
          return json({ error: 'invalid_request' }, 400)
        }
        const { setupSessionId, ...checkout } = body.data
        if (setupSessionId) {
          // The plans dialog joins the open setup session only for its own user and team.
          const session = await loadSetupSession(env, setupSessionId, now)
          if (!session || session.user_id !== caller.userId || (session.account_id && session.account_id !== caller.accountId)) {
            return json({ error: 'setup_session_mismatch' }, 409)
          }
        }
        const outcome = await createCheckout(env, stripe, caller, checkout, now, membership, setupSessionId ? { setupSessionId } : {})
        return outcome.ok ? json({ url: outcome.url }) : json({ error: outcome.error }, outcome.status)
      }

      case 'POST /v1/billing/overage': {
        const caller = await authenticateDesktop(env, request, { maxTokenAge: ADMIN_ACTION_MAX_TOKEN_AGE })
        if (!caller) {
          return json({ error: 'unauthorized' }, 401)
        }
        const body = OverageRequestSchema.safeParse(await readJson(request))
        if (!body.success) {
          return json({ error: 'invalid_request' }, 400)
        }
        const outcome = await updateOverage(env, stripe, caller, body.data, now)
        if (!outcome.ok) {
          return json({ error: outcome.error }, outcome.status)
        }
        return json(await desktopEntitlement(env, caller, request, now))
      }

      case 'POST /v1/internal/seats': {
        if (!(await authenticateMembershipSync(env, request))) {
          return json({ error: 'unauthorized' }, 401)
        }
        const body = SeatSyncSchema.safeParse(await readJson(request))
        if (!body.success) {
          return json({ error: 'invalid_request' }, 400)
        }
        return json(await syncSeats(env, stripe, body.data.accountId, body.data.members, now))
      }

      case 'GET /v1/internal/suspensions': {
        // Accounts whose payment grace ran out: suspend their running sandboxes (poll from a cron).
        if (!(await authenticateControlPlane(env, request))) {
          return json({ error: 'unauthorized' }, 401)
        }
        const graceMs = (await suspensionGraceHours(env, now)) * 3600_000
        const accounts = await graceExpiredAccounts(env.BILLING_DB, now - graceMs)
        return json({
          accounts: accounts.map((row) => ({
            accountId: row.account_id,
            pastDueSince: row.past_due_since,
            graceEndsAt: row.past_due_since + graceMs
          }))
        })
      }

      case 'POST /v1/billing/portal': {
        const caller = await authenticateDesktop(env, request, { maxTokenAge: ADMIN_ACTION_MAX_TOKEN_AGE })
        if (!caller) {
          return json({ error: 'unauthorized' }, 401)
        }
        const outcome = await createPortal(env, stripe, caller)
        return outcome.ok ? json({ url: outcome.url }) : json({ error: outcome.error }, outcome.status)
      }

      case 'POST /v1/internal/entitlements/check': {
        if (!(await authenticateControlPlane(env, request))) {
          return json({ error: 'unauthorized' }, 401)
        }
        const body = StartCheckSchema.safeParse(await readJson(request))
        if (!body.success) {
          return json({ error: 'invalid_request' }, 400)
        }
        const entitlement = await computeEntitlement(env, body.data.accountId, now, 'start_check')
        return json({
          ...checkStart(entitlement, body.data),
          // Billed seats: the period's peak (never raw membership), so caps can't be inflated by
          // adding members the org hasn't paid for, nor shrunk by mid-period removals.
          seats: entitlement.seats,
          maxConcurrentSandboxes: entitlement.limits.maxConcurrentSandboxes,
          maxConcurrentSandboxesPerMember: entitlement.limits.maxConcurrentSandboxesPerMember,
          entitlement
        })
      }

      case 'POST /v1/internal/usage': {
        if (!(await authenticateControlPlane(env, request))) {
          return json({ error: 'unauthorized' }, 401)
        }
        const body = UsageReportSchema.safeParse(await readJson(request))
        if (!body.success) {
          return json({ error: 'invalid_request' }, 400)
        }
        const invalid = validateSegment(body.data, now)
        if (invalid) {
          return json({ error: invalid }, 400)
        }
        const result = await recordUsage(env, body.data, now)
        if (result.overageSeconds > 0) {
          // Best effort inline; the cron trigger retries whatever is still pending.
          ctx.waitUntil(flushMeterReports(env, stripe, now, { usageId: body.data.usageId }).catch(() => undefined))
        }
        const entitlement = await computeEntitlement(env, body.data.accountId, now, 'usage')
        return json({
          ...result,
          canStartSandbox: entitlement.canStartSandbox,
          reason: entitlement.reason,
          suspendRunning: entitlement.suspendRunning
        })
      }

      default:
        return json({ error: 'not_found' }, 404)
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      return json({ error: 'invalid_json' }, 400)
    }
    if (error instanceof LiveModeRefusedError || error instanceof PlanConfigError || error instanceof CatalogUnavailableError) {
      return json({ error: 'billing_misconfigured' }, 503)
    }
    if (error instanceof MembershipUnavailableError) {
      // Never guess a seat count: fail the action until auth answers.
      console.error(JSON.stringify({ route, error: 'membership', message: error.message }))
      return json({ error: 'membership_unavailable' }, 503)
    }
    if (error instanceof StripeError) {
      // Stripe's message never contains the key or card data.
      console.error(JSON.stringify({ route, error: 'stripe', status: error.status, code: error.code, message: error.message }))
      return json({ error: 'stripe_unavailable' }, 502)
    }
    console.error(JSON.stringify({ route, error: error instanceof Error ? error.name : 'unknown', message: error instanceof Error ? error.message.slice(0, 200) : '' }))
    return json({ error: 'internal_error' }, 500)
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx)
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const stripe = createStripeClient(env)
    ctx.waitUntil(flushMeterReports(env, stripe, Date.now()).then(() => undefined))
    // Seat drift from a missed membership push heals here (needs AUTH_INTERNAL_URL).
    ctx.waitUntil(reconcileSeats(env, stripe, authMembershipSource(env), Date.now()).then(() => undefined))
    // Stripe -> billing reconciliation: event replay, rolling re-sync, catalog prices (reconcile.ts),
    // then entitlement grant backfill/heal. Both are no-ops while ENTITLEMENTS_MODE is off.
    ctx.waitUntil(
      reconcile(env, stripe, Date.now())
        .then(() => backfillGrants(env, Date.now()))
        .then((result) => {
          if (result.subscriptions + result.trials + result.failed > 0) {
            console.log(JSON.stringify({ event: 'entitlements_backfill', ...result }))
          }
        })
        .catch((error: unknown) => {
          console.error(JSON.stringify({ error: 'entitlements_backfill', message: error instanceof Error ? error.message.slice(0, 200) : '' }))
        })
    )
  }
} satisfies ExportedHandler<Env>
