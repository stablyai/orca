// Orca billing Worker: Stripe Checkout/Portal, Stripe webhooks, entitlements and usage.
//
// Desktop (Orca Cloud billing JWT):
//   GET  /v1/billing/entitlements          current plan, hours used/remaining, can-start
//   POST /v1/billing/checkout {plan,seats}  -> { url } hosted Stripe Checkout
//   POST /v1/billing/portal                 -> { url } Stripe Customer Portal
// Stripe:
//   POST /v1/stripe/webhook                 signed events
// Sandbox control plane (CONTROL_PLANE_TOKEN):
//   POST /v1/internal/entitlements/check {accountId, machineSize, runningSandboxes}
//   POST /v1/internal/usage {usageId, accountId, sandboxId, machineSize, startedAt, endedAt}
import { z } from 'zod'
import { authenticateControlPlane, authenticateDesktop } from './auth'
import { CheckoutRequestSchema, createCheckout, createPortal } from './checkout'
import { checkStart, computeEntitlement } from './entitlements'
import type { Env } from './env'
import { MACHINE_SIZES } from './plans'
import { LiveModeRefusedError, StripeError, createStripeClient, type StripeClient } from './stripe'
import { UsageReportSchema, flushMeterReports, recordUsage, validateSegment } from './usage'
import { handleStripeWebhook } from './webhook'

const MAX_JSON_BYTES = 16 * 1024

const StartCheckSchema = z
  .object({
    accountId: z.string().min(1).max(128),
    machineSize: z.enum(MACHINE_SIZES),
    runningSandboxes: z.number().int().min(0).max(10_000)
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

export type Deps = { stripe?: StripeClient; now?: () => number }

export async function handleRequest(request: Request, env: Env, ctx: ExecutionContext, deps: Deps = {}): Promise<Response> {
  const url = new URL(request.url)
  const now = deps.now?.() ?? Date.now()
  const stripe = deps.stripe ?? createStripeClient(env)
  const route = `${request.method} ${url.pathname}`
  try {
    switch (route) {
      case 'POST /v1/stripe/webhook':
        return await handleStripeWebhook(env, stripe, request, now)

      case 'GET /v1/billing/entitlements': {
        const caller = await authenticateDesktop(env, request)
        if (!caller) {
          return json({ error: 'unauthorized' }, 401)
        }
        const entitlement = await computeEntitlement(env.BILLING_DB, caller.accountId)
        return json({ ...entitlement, canManageBilling: caller.canManage })
      }

      case 'POST /v1/billing/checkout': {
        const caller = await authenticateDesktop(env, request)
        if (!caller) {
          return json({ error: 'unauthorized' }, 401)
        }
        const body = CheckoutRequestSchema.safeParse(await readJson(request))
        if (!body.success) {
          return json({ error: 'invalid_request' }, 400)
        }
        const outcome = await createCheckout(env, stripe, caller, body.data, now)
        return outcome.ok ? json({ url: outcome.url }) : json({ error: outcome.error }, outcome.status)
      }

      case 'POST /v1/billing/portal': {
        const caller = await authenticateDesktop(env, request)
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
        const entitlement = await computeEntitlement(env.BILLING_DB, body.data.accountId)
        return json({ ...checkStart(entitlement, body.data), entitlement })
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
        const entitlement = await computeEntitlement(env.BILLING_DB, body.data.accountId)
        return json({ ...result, canStartSandbox: entitlement.canStartSandbox, reason: entitlement.reason })
      }

      default:
        return json({ error: 'not_found' }, 404)
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      return json({ error: 'invalid_json' }, 400)
    }
    if (error instanceof LiveModeRefusedError) {
      return json({ error: 'billing_misconfigured' }, 503)
    }
    if (error instanceof StripeError) {
      return json({ error: 'stripe_unavailable' }, 502)
    }
    return json({ error: 'internal_error' }, 500)
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx)
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(flushMeterReports(env, createStripeClient(env), Date.now()).then(() => undefined))
  }
} satisfies ExportedHandler<Env>
