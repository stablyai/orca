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

  async function request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params?: FormRecord, idempotencyKey?: string) {
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
    listOpenCheckoutSessions(customer: string) {
      return request<{ data: Array<{ id: string; status: string }> }>('GET', '/v1/checkout/sessions', {
        customer,
        status: 'open',
        limit: '10'
      })
    },
    expireCheckoutSession(id: string) {
      return request<{ id: string; status: string }>(
        'POST',
        `/v1/checkout/sessions/${encodeURIComponent(id)}/expire`,
        {},
        `checkout-expire:${id}`
      )
    },
    createPortalSession(args: { customer: string; returnUrl: string; configuration?: string }, idempotencyKey: string) {
      return request<{ id: string; url: string }>(
        'POST',
        '/v1/billing_portal/sessions',
        { customer: args.customer, return_url: args.returnUrl, configuration: args.configuration },
        idempotencyKey
      )
    },
    /** `after`: the id a replayed add returned for an item since removed, so this add is a new one. */
    addSubscriptionItem(args: { subscription: string; price: string; after?: string }) {
      return request<{ id: string }>(
        'POST',
        '/v1/subscription_items',
        // Metered: nothing to prorate; usage is billed in arrears.
        { subscription: args.subscription, price: args.price, proration_behavior: 'none' },
        `overage-item:${args.subscription}:${args.price}${args.after ? `:after:${args.after}` : ''}`
      )
    },
    /** Moves an item to another price in place (an older overage price to the current one). */
    setSubscriptionItemPrice(args: { item: string; price: string }) {
      return request<{ id: string; price: { id: string } }>(
        'POST',
        `/v1/subscription_items/${encodeURIComponent(args.item)}`,
        { price: args.price, proration_behavior: 'none' },
        `overage-item-price:${args.item}:${args.price}`
      )
    },
    /**
     * Cancels a subscription now (EP-10, deleting a team whose plan is already set to end):
     * metered usage already reported is invoiced (invoice_now), the unused time isn't refunded
     * (prorate false). DELETE is idempotent in Stripe; an already canceled one answers 404/400.
     */
    cancelSubscriptionNow(id: string) {
      return request<{ id: string; status: string }>('DELETE', `/v1/subscriptions/${encodeURIComponent(id)}`, {
        invoice_now: 'true',
        prorate: 'false'
      })
    },
    /** DELETE is idempotent in Stripe, so no idempotency key (Stripe ignores one there). */
    deleteSubscriptionItem(item: string) {
      return request<{ id: string; deleted: boolean }>(
        'DELETE',
        `/v1/subscription_items/${encodeURIComponent(item)}`,
        { proration_behavior: 'none' }
      )
    },
    setSubscriptionItemQuantity(args: {
      item: string
      quantity: number
      prorationBehavior: 'always_invoice' | 'none'
      idempotencyKey: string
    }) {
      return request<{ id: string; quantity: number }>(
        'POST',
        `/v1/subscription_items/${encodeURIComponent(args.item)}`,
        { quantity: args.quantity, proration_behavior: args.prorationBehavior },
        args.idempotencyKey
      )
    },
    /** Active prices holding these lookup keys (the catalog's checkout prices). */
    listPricesByLookupKeys(lookupKeys: string[]) {
      return request<{ data: StripePrice[] }>('GET', '/v1/prices', { lookup_keys: lookupKeys, active: 'true', limit: '100' })
    },
    /**
     * Events of these types newer than `endingBefore` (the page right after it), or the newest when
     * absent. Stripe lists newest first; Stripe keeps events for 30 days.
     */
    listEvents(args: { types: string[]; endingBefore?: string; limit: number }) {
      return request<{ data: StripeEventObject[]; has_more: boolean }>('GET', '/v1/events', {
        types: args.types,
        ending_before: args.endingBefore,
        limit: String(args.limit)
      })
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
  /** Set by the portal's cancel (newer API versions) instead of cancel_at_period_end; epoch seconds. */
  cancel_at?: number | null
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
      price: StripePrice
    }>
  }
}

/** The Price fields billing reads (subscription items embed the whole Price object). */
export type StripePrice = {
  id: string
  active?: boolean
  livemode?: boolean
  currency?: string
  unit_amount?: number | null
  unit_amount_decimal?: string | null
  lookup_key?: string | null
  /** `orca_plan` names the catalog plan this price sells (the join key, set on every price we create). */
  metadata?: Record<string, string> | null
  product?: string | { id: string } | null
  recurring?: { interval?: string; usage_type?: string } | null
}

export type StripeEventObject = {
  id: string
  type: string
  created?: number
  livemode: boolean
  data: { object: Record<string, unknown> }
}
