// Orca billing Worker: Stripe Checkout/Portal, Stripe webhooks, entitlements and usage.
//
// Desktop (Orca Cloud billing JWT):
//   GET  /v1/billing/entitlements          current plan, hours used/remaining, can-start
//   POST /v1/billing/checkout {plan,interval,seats} -> { url } hosted Stripe Checkout
//   POST /v1/billing/overage {enabled, spendCapCents?} opt in/out of overage, set the cap
//   POST /v1/billing/portal                 -> { url } Stripe Customer Portal
// Stripe:
//   POST /v1/stripe/webhook                 signed events
// Sandbox control plane (CONTROL_PLANE_TOKEN):
//   POST /v1/internal/entitlements/check {accountId, machineSize, runningSandboxes}
//   POST /v1/internal/usage {usageId, accountId, sandboxId, machineSize, startedAt, endedAt}
//   GET  /v1/internal/suspensions          accounts whose payment grace expired (suspend running)
// Orca Cloud auth (MEMBERSHIP_SYNC_TOKEN):
//   POST /v1/internal/seats {accountId, members}
import { z } from 'zod'
import {
  ADMIN_ACTION_MAX_TOKEN_AGE,
  authenticateControlPlane,
  authenticateDesktop,
  authenticateMembershipSync
} from './auth'
import { SeatSyncSchema, reconcileSeats, syncSeats } from './seats'
import { MembershipUnavailableError, authMembershipSource, type MembershipSource } from './membership'
import { graceExpiredAccounts } from './store'
import { CheckoutRequestSchema, createCheckout, createPortal } from './checkout'
import { checkStart, computeEntitlement } from './entitlements'
import type { Env } from './env'
import { MACHINE_SIZES, PlanConfigError, planCatalog, publicOffers } from './plans'
import { OverageRequestSchema, updateOverage } from './overage'
import { LiveModeRefusedError, StripeError, createStripeClient, type StripeClient } from './stripe'
import { UsageReportSchema, flushMeterReports, recordUsage, validateSegment } from './usage'
import { handleStripeWebhook } from './webhook'
import { renderReturnPage, returnOutcome } from './return-page'

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

export type Deps = { stripe?: StripeClient; now?: () => number; membership?: MembershipSource }

export async function handleRequest(request: Request, env: Env, ctx: ExecutionContext, deps: Deps = {}): Promise<Response> {
  const url = new URL(request.url)
  const now = deps.now?.() ?? Date.now()
  const stripe = deps.stripe ?? createStripeClient(env)
  const membership = deps.membership ?? authMembershipSource(env)
  const route = `${request.method} ${url.pathname}`
  try {
    switch (route) {
      case 'GET /return':
        // Where Checkout and the Portal send the browser back; hands off to the desktop app.
        return renderReturnPage(returnOutcome(url))

      case 'POST /v1/stripe/webhook':
        return await handleStripeWebhook(env, stripe, request, now)

      case 'GET /v1/billing/entitlements': {
        const caller = await authenticateDesktop(env, request)
        if (!caller) {
          return json({ error: 'unauthorized' }, 401)
        }
        const entitlement = await computeEntitlement(env, caller.accountId, now)
        return json({ ...entitlement, canManageBilling: caller.canManage, offers: publicOffers(planCatalog(env)) })
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
        const outcome = await createCheckout(env, stripe, caller, body.data, now, membership)
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
        const entitlement = await computeEntitlement(env, caller.accountId, now)
        return json({ ...entitlement, canManageBilling: caller.canManage, offers: publicOffers(planCatalog(env)) })
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
        const graceMs = planCatalog(env).team.paymentGraceHours * 3600_000
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
        const entitlement = await computeEntitlement(env, body.data.accountId, now)
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
        const entitlement = await computeEntitlement(env, body.data.accountId, now)
        return json({
          ...result,
          canStartSandbox: entitlement.canStartSandbox,
          reason: entitlement.reason,
          suspendRunning: entitlement.payment.suspendRunning
        })
      }

      default:
        return json({ error: 'not_found' }, 404)
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      return json({ error: 'invalid_json' }, 400)
    }
    if (error instanceof LiveModeRefusedError || error instanceof PlanConfigError) {
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
  }
} satisfies ExportedHandler<Env>
