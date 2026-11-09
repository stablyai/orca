// Minimal Stripe REST client over fetch: only the calls billing makes. Form-encoded bodies,
// pinned API version, an Idempotency-Key on every POST, and a hard refusal of live-mode keys
// unless STRIPE_ALLOW_LIVEMODE is exactly 'true'.
import type { Env } from './env'

export const DEFAULT_STRIPE_API_VERSION = '2025-09-30.clover'
const STRIPE_TIMEOUT_MS = 15_000

export class StripeError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string
  ) {
    super(message)
    this.name = 'StripeError'
  }
}

export class LiveModeRefusedError extends Error {
  constructor() {
    super('stripe_livemode_refused')
    this.name = 'LiveModeRefusedError'
  }
}

export function allowsLiveMode(env: Env): boolean {
  return env.STRIPE_ALLOW_LIVEMODE === 'true'
}

/** Throws unless the key is a test-mode key (or live mode was explicitly enabled). */
export function assertKeyMode(env: Env): void {
  const key = env.STRIPE_SECRET_KEY ?? ''
  const isTest = key.startsWith('sk_test_') || key.startsWith('rk_test_')
  const isLive = key.startsWith('sk_live_') || key.startsWith('rk_live_')
  if (isLive && !allowsLiveMode(env)) {
    throw new LiveModeRefusedError()
  }
  if (!isTest && !isLive) {
    throw new Error('stripe_key_missing')
  }
}

type FormValue = string | number | boolean | null | undefined | FormRecord | FormValue[]
type FormRecord = { [key: string]: FormValue }

/** Stripe's bracket encoding: a[b][0][c]=v. Undefined/null values are omitted. */
export function encodeForm(params: FormRecord): string {
  const pairs: string[] = []
  const walk = (prefix: string, value: FormValue): void => {
    if (value === undefined || value === null) {
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(`${prefix}[${index}]`, item))
      return
    }
    if (typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        walk(prefix ? `${prefix}[${key}]` : key, inner)
      }
      return
    }
    pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`)
  }
  walk('', params)
  return pairs.join('&')
}

export type StripeClient = ReturnType<typeof createStripeClient>

export function createStripeClient(env: Env, fetchImpl: typeof fetch = fetch) {
  const base = env.STRIPE_API_BASE ?? 'https://api.stripe.com'
  const version = env.STRIPE_API_VERSION ?? DEFAULT_STRIPE_API_VERSION

  async function request<T>(method: 'GET' | 'POST', path: string, params?: FormRecord, idempotencyKey?: string) {
    assertKeyMode(env)
    const headers: Record<string, string> = {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'stripe-version': version
    }
    let url = `${base}${path}`
    let body: string | undefined
    if (method === 'POST') {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      body = encodeForm(params ?? {})
      if (idempotencyKey) {
        headers['idempotency-key'] = idempotencyKey
      }
    } else if (params) {
      url += `?${encodeForm(params)}`
    }
    const response = await fetchImpl(url, {
      method,
      headers,
      body,
      // Never follow a redirect with the key attached. Workers reject redirect: 'error', so take
      // the 3xx manually and fail it below (a 3xx is never ok).
      redirect: 'manual',
      signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS)
    })
    const json = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }
    if (!response.ok) {
      // Stripe's message never contains the key; still keep it short for logs.
      throw new StripeError(response.status, json.error?.code, (json.error?.message ?? 'stripe_error').slice(0, 200))
    }
    return json as T
  }

  return {
    createCustomer(args: { accountId: string; email?: string; name?: string }) {
      return request<{ id: string }>(
        'POST',
        '/v1/customers',
        { email: args.email, name: args.name, metadata: { account_id: args.accountId } },
        // Stable per account: a retried first checkout cannot create a second customer.
        `customer-create:${args.accountId}`
      )
    },
    createCheckoutSession(params: FormRecord, idempotencyKey: string) {
      return request<{ id: string; url: string }>('POST', '/v1/checkout/sessions', params, idempotencyKey)
    },
    createPortalSession(args: { customer: string; returnUrl: string; configuration?: string }, idempotencyKey: string) {
      return request<{ id: string; url: string }>(
        'POST',
        '/v1/billing_portal/sessions',
        { customer: args.customer, return_url: args.returnUrl, configuration: args.configuration },
        idempotencyKey
      )
    },
    addSubscriptionItem(args: { subscription: string; price: string }) {
      return request<{ id: string }>(
        'POST',
        '/v1/subscription_items',
        // Metered: nothing to prorate; usage is billed in arrears.
        { subscription: args.subscription, price: args.price, proration_behavior: 'none' },
        `overage-item:${args.subscription}:${args.price}`
      )
    },
    setSubscriptionItemQuantity(args: {
      item: string
      quantity: number
      prorationBehavior: 'always_invoice' | 'create_prorations'
      idempotencyKey: string
    }) {
      return request<{ id: string; quantity: number }>(
        'POST',
        `/v1/subscription_items/${encodeURIComponent(args.item)}`,
        { quantity: args.quantity, proration_behavior: args.prorationBehavior },
        args.idempotencyKey
      )
    },
    retrieveSubscription(id: string) {
      return request<StripeSubscription>('GET', `/v1/subscriptions/${encodeURIComponent(id)}`)
    },
    createMeterEvent(args: { eventName: string; customer: string; value: number; identifier: string; timestamp: number }) {
      return request<{ identifier: string }>(
        'POST',
        '/v1/billing/meter_events',
        {
          event_name: args.eventName,
          identifier: args.identifier,
          timestamp: Math.floor(args.timestamp / 1000),
          payload: { stripe_customer_id: args.customer, value: String(args.value) }
        },
        `meter:${args.identifier}`
      )
    }
  }
}

// Fields billing reads. Since API 2025-03-31 the period lives on each item; older payloads keep it
// on the subscription, so both are read.
export type StripeSubscription = {
  id: string
  object: 'subscription'
  customer: string | { id: string }
  status: string
  cancel_at_period_end: boolean
  livemode: boolean
  metadata?: Record<string, string>
  current_period_start?: number
  current_period_end?: number
  items: {
    data: Array<{
      id: string
      quantity?: number
      current_period_start?: number
      current_period_end?: number
      price: { id: string }
    }>
  }
}
