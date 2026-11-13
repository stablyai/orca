// HTTP calls behind "Plan & billing": mint a short-lived billing token from Orca Cloud auth,
// then call the billing service with it. Pure (fetch injected) so it is testable without Electron.
import { z } from 'zod'
import type {
  OrcaBillingCheckoutArgs,
  OrcaBillingEntitlement,
  OrcaBillingOverageArgs,
  OrcaBillingTeamPlan
} from '../../shared/orca-billing'
import { OrcaCloudRequestError } from '../orca-profiles/cloud-auth/profile-cloud-client'
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

/** Auth older than the explicit-org body answers 400; skip the body for a while after one. */
const explicitOrg = { unsupportedUntil: 0 }
const EXPLICIT_ORG_RETRY_MS = 10 * 60_000

/** The `org` claim of a billing token (null: personal). Decodes only; billing verifies it. */
export function readBillingTokenOrg(token: string): string | null {
  let payload: unknown = null
  try {
    payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
  } catch {
    // Reported below without echoing the token.
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('invalid_billing_token')
  }
  const org = 'org' in payload ? payload.org : undefined
  return typeof org === 'string' && org ? org : null
}

/** The minted token speaks for a different team than the one this device shows (EP-9). */
export class BillingOrgMismatchError extends Error {
  constructor(readonly requested: string | null) {
    super('billing_org_mismatch')
    this.name = 'BillingOrgMismatchError'
  }
}

/**
 * POST to Orca Cloud auth for a billing token for `orgId`, the team THIS device shows (null:
 * personal). Auth used to pick the team from the profile's active team, which a user's other
 * devices share, so one device switching teams made the other read and act on that team's plan
 * (EP-9). The token's org claim is checked; a token for any other team is refused, never used.
 * A 401/403 is surfaced as OrcaCloudRequestError so the caller's session refresh retries once.
 */
export async function mintBillingToken(
  endpoints: BillingEndpoints,
  accessToken: string,
  orgId: string | null,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const post = (body: string) =>
    fetchImpl(endpoints.billingTokenEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  const explicit = Date.now() >= explicitOrg.unsupportedUntil
  let response = await post(explicit ? JSON.stringify({ orgId }) : '{}')
  if (explicit && response.status === 400) {
    // Auth older than the explicit-org contract (#761) rejects any body; the claim check below
    // still refuses a token for the wrong team.
    explicitOrg.unsupportedUntil = Date.now() + EXPLICIT_ORG_RETRY_MS
    response = await post('{}')
  }
  if (!response.ok) {
    throw new OrcaCloudRequestError(response.status, (await readErrorCode(response)) ?? undefined)
  }
  const body = TokenBody.safeParse(await response.json())
  if (!body.success) {
    throw new Error('invalid_billing_token')
  }
  if (readBillingTokenOrg(body.data.billingToken) !== orgId) {
    throw new BillingOrgMismatchError(orgId)
  }
  return body.data.billingToken
}

/** Test hook: forget a remembered "auth doesn't take an explicit org". */
export function resetBillingExplicitOrgForTests(): void {
  explicitOrg.unsupportedUntil = 0
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
