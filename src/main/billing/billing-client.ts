// HTTP calls behind "Plan & billing": mint a short-lived billing token from Orca Cloud auth,
// then call the billing service with it. Pure (fetch injected) so it is testable without Electron.
import { z } from 'zod'
import type {
  OrcaBillingCheckoutArgs,
  OrcaBillingEntitlement,
  OrcaBillingOverageArgs,
  OrcaBillingTeamPlan
} from '../../shared/orca-billing'
import { OrcaCloudRequestError } from '../orca-profiles/profile-cloud-client'
import { normalizeEntitlement } from './billing-entitlement-schema'

export { normalizeEntitlement }

const REQUEST_TIMEOUT_MS = 20_000
const MAX_TOKEN_LENGTH = 8 * 1024

export type BillingEndpoints = {
  billingApiUrl: string
  billingTokenEndpoint: string
}

/** A billing-service refusal (never an Orca session failure: it must not sign the user out). */
export class BillingServiceError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly errorCode: string | null
  ) {
    super(errorCode ?? `billing_request_failed_${statusCode}`)
    this.name = 'BillingServiceError'
  }
}

const ErrorBody = z.object({ error: z.string().max(64) })
const TokenBody = z.object({
  billingToken: z.string().min(1).max(MAX_TOKEN_LENGTH)
})
const UrlBody = z.object({ url: z.string() })
const JsonObject = z.record(z.string(), z.unknown())

async function readErrorCode(response: Response): Promise<string | null> {
  const parsed = ErrorBody.safeParse(await response.json().catch(() => null))
  return parsed.success ? parsed.data.error : null
}

/** POST to Orca Cloud auth. A 401/403 is surfaced as OrcaCloudRequestError so the caller's
 * session-refresh wrapper refreshes the Orca session once and retries. */
export async function mintBillingToken(
  endpoints: BillingEndpoints,
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const response = await fetchImpl(endpoints.billingTokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`
    },
    body: '{}',
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new OrcaCloudRequestError(response.status, (await readErrorCode(response)) ?? undefined)
  }
  const body = TokenBody.safeParse(await response.json())
  if (!body.success) {
    throw new Error('invalid_billing_token')
  }
  return body.data.billingToken
}

export async function billingRequest(
  endpoints: BillingEndpoints,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  fetchImpl: typeof fetch
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(new URL(path, `${endpoints.billingApiUrl}/`).toString(), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {})
    },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new BillingServiceError(response.status, await readErrorCode(response))
  }
  const json = JsonObject.safeParse(await response.json())
  if (!json.success) {
    throw new Error('invalid_billing_response')
  }
  return json.data
}

// Only Stripe's hosted pages may be opened from a billing response.
const STRIPE_HOSTS = new Set(['checkout.stripe.com', 'billing.stripe.com'])

export function assertStripeHostedUrl(value: unknown): string {
  if (typeof value !== 'string' || !URL.canParse(value)) {
    throw new Error('invalid_billing_url')
  }
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    !STRIPE_HOSTS.has(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error('invalid_billing_url')
  }
  return url.toString()
}

export async function fetchEntitlement(
  endpoints: BillingEndpoints,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<OrcaBillingEntitlement> {
  return normalizeEntitlement(
    await billingRequest(endpoints, token, 'GET', 'v1/billing/entitlements', undefined, fetchImpl)
  )
}

export async function createCheckoutUrl(
  endpoints: BillingEndpoints,
  token: string,
  args: OrcaBillingCheckoutArgs,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const body = await billingRequest(
    endpoints,
    token,
    'POST',
    'v1/billing/checkout',
    {
      plan: args.plan,
      interval: args.interval,
      seats: args.seats,
      ...(args.setupSessionId ? { setupSessionId: args.setupSessionId } : {})
    },
    fetchImpl
  )
  return assertStripeHostedUrl(UrlBody.safeParse(body).data?.url)
}

export async function createPortalUrl(
  endpoints: BillingEndpoints,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const body = await billingRequest(endpoints, token, 'POST', 'v1/billing/portal', {}, fetchImpl)
  return assertStripeHostedUrl(UrlBody.safeParse(body).data?.url)
}

export async function updateOverage(
  endpoints: BillingEndpoints,
  token: string,
  args: OrcaBillingOverageArgs,
  fetchImpl: typeof fetch = fetch
): Promise<OrcaBillingEntitlement> {
  return normalizeEntitlement(
    await billingRequest(
      endpoints,
      token,
      'POST',
      'v1/billing/overage',
      args.spendCapCents === undefined
        ? { enabled: args.enabled }
        : { enabled: args.enabled, spendCapCents: args.spendCapCents },
      fetchImpl
    )
  )
}

const TeamPlansBody = z.object({
  teams: z
    .array(
      z.object({
        orgId: z.string().min(1).max(128),
        plan: z.string().max(40).nullable(),
        planLabel: z.string().max(40).nullable(),
        canStartSandbox: z.boolean()
      })
    )
    .max(20)
})

/** Plan state for other teams the caller is on (cloud start B2), read with the caller's own token. */
export async function fetchTeamPlans(
  endpoints: BillingEndpoints,
  token: string,
  orgIds: readonly string[],
  fetchImpl: typeof fetch = fetch
): Promise<OrcaBillingTeamPlan[]> {
  const body = TeamPlansBody.safeParse(
    await billingRequest(endpoints, token, 'POST', 'v1/billing/team-plans', { orgIds }, fetchImpl)
  )
  if (!body.success) {
    throw new Error('invalid_billing_response')
  }
  return body.data.teams
}

/** POST /v1/billing/trial: starts the team's one-time trial (idempotent) and returns the entitlement. */
export async function claimTrial(
  endpoints: BillingEndpoints,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<OrcaBillingEntitlement> {
  return normalizeEntitlement(
    await billingRequest(endpoints, token, 'POST', 'v1/billing/trial', {}, fetchImpl)
  )
}
