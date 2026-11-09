// In-memory Stripe API behind a fetch function, plus event fixtures shaped like Stripe's
// (API version 2025-09-30.clover: periods on subscription items, invoice.parent.subscription_details).
// The real client in src/stripe.ts talks to it, so form encoding and headers are exercised too.
import { createHmac } from 'node:crypto'

export type FakeSubscription = {
  id: string
  object: 'subscription'
  customer: string
  status: string
  cancel_at_period_end: boolean
  livemode: boolean
  metadata: Record<string, string>
  items: { object: 'list'; data: Array<{ id: string; quantity?: number; current_period_start: number; current_period_end: number; price: { id: string } }> }
}

export type RecordedCall = { method: string; path: string; form: URLSearchParams; headers: Headers }

export function createFakeStripe() {
  const calls: RecordedCall[] = []
  const customers = new Map<string, { id: string; metadata: Record<string, string> }>()
  const subscriptions = new Map<string, FakeSubscription>()
  const idempotent = new Map<string, unknown>()
  const meterEvents: Array<Record<string, string>> = []
  let nextId = 1
  let failMeterEvents = 0

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const headers = new Headers(init?.headers)
    const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '')
    const method = init?.method ?? 'GET'
    calls.push({ method, path: url.pathname, form, headers })
    if (!headers.get('authorization')?.startsWith('Bearer rk_test_')) {
      return Response.json({ error: { message: 'Invalid API Key provided' } }, { status: 401 })
    }
    const key = headers.get('idempotency-key')
    if (method === 'POST' && key && idempotent.has(key)) {
      return Response.json(idempotent.get(key))
    }
    const respond = (body: unknown) => {
      if (method === 'POST' && key) {
        idempotent.set(key, body)
      }
      return Response.json(body)
    }
    if (method === 'POST' && url.pathname === '/v1/customers') {
      const id = `cus_test_${nextId++}`
      const customer = { id, metadata: { account_id: form.get('metadata[account_id]') ?? '' } }
      customers.set(id, customer)
      return respond(customer)
    }
    if (method === 'POST' && url.pathname === '/v1/checkout/sessions') {
      const id = `cs_test_${nextId++}`
      return respond({ id, object: 'checkout.session', url: `https://checkout.stripe.com/c/pay/${id}` })
    }
    if (method === 'POST' && url.pathname === '/v1/billing_portal/sessions') {
      const id = `bps_test_${nextId++}`
      return respond({ id, url: `https://billing.stripe.com/p/session/${id}` })
    }
    if (method === 'GET' && url.pathname.startsWith('/v1/subscriptions/')) {
      const subscription = subscriptions.get(decodeURIComponent(url.pathname.slice('/v1/subscriptions/'.length)))
      return subscription
        ? Response.json(subscription)
        : Response.json({ error: { code: 'resource_missing', message: 'No such subscription' } }, { status: 404 })
    }
    if (method === 'POST' && url.pathname === '/v1/billing/meter_events') {
      if (failMeterEvents > 0) {
        failMeterEvents--
        return Response.json({ error: { message: 'temporarily unavailable' } }, { status: 503 })
      }
      meterEvents.push(Object.fromEntries(form))
      return respond({ object: 'billing.meter_event', identifier: form.get('identifier') })
    }
    return Response.json({ error: { message: `unhandled ${method} ${url.pathname}` } }, { status: 404 })
  }

  return {
    fetchImpl,
    calls,
    customers,
    subscriptions,
    meterEvents,
    failNextMeterEvents(count: number) {
      failMeterEvents = count
    },
    /** What Stripe holds after Checkout completes for `customer` (the test plays the browser). */
    putSubscription(args: {
      customer: string
      accountId: string
      basePrice: string
      overagePrice?: string
      quantity?: number
      status?: string
      periodStart: number
      periodEnd: number
      livemode?: boolean
    }): FakeSubscription {
      const id = `sub_test_${nextId++}`
      const period = { current_period_start: args.periodStart, current_period_end: args.periodEnd }
      const data: FakeSubscription['items']['data'] = [
        { id: `si_test_${nextId++}`, quantity: args.quantity ?? 1, price: { id: args.basePrice }, ...period }
      ]
      if (args.overagePrice) {
        data.push({ id: `si_test_${nextId++}`, price: { id: args.overagePrice }, ...period })
      }
      const subscription: FakeSubscription = {
        id,
        object: 'subscription',
        customer: args.customer,
        status: args.status ?? 'active',
        cancel_at_period_end: false,
        livemode: args.livemode ?? false,
        metadata: { account_id: args.accountId },
        items: { object: 'list', data }
      }
      subscriptions.set(id, subscription)
      return subscription
    }
  }
}

let eventCounter = 1

export function stripeEvent(type: string, object: Record<string, unknown>, options: { livemode?: boolean; id?: string } = {}) {
  return {
    id: options.id ?? `evt_test_${eventCounter++}`,
    object: 'event',
    api_version: '2025-09-30.clover',
    created: Math.floor(Date.now() / 1000),
    livemode: options.livemode ?? false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    data: { object }
  }
}

export function checkoutCompleted(args: { customer: string; subscription: string; accountId: string }) {
  return stripeEvent('checkout.session.completed', {
    id: `cs_test_${eventCounter++}`,
    object: 'checkout.session',
    mode: 'subscription',
    status: 'complete',
    payment_status: 'paid',
    customer: args.customer,
    subscription: args.subscription,
    client_reference_id: args.accountId,
    metadata: { account_id: args.accountId }
  })
}

export function invoiceEvent(type: 'invoice.paid' | 'invoice.payment_failed', subscription: string, customer: string) {
  return stripeEvent(type, {
    id: `in_test_${eventCounter++}`,
    object: 'invoice',
    customer,
    parent: { type: 'subscription_details', subscription_details: { subscription } }
  })
}

/** Signs exactly like Stripe (and stripe-node's generateTestHeaderString), via node:crypto. */
export function signStripePayload(payload: string, secret: string, timestampSeconds = Math.floor(Date.now() / 1000)): string {
  const signature = createHmac('sha256', secret).update(`${timestampSeconds}.${payload}`, 'utf8').digest('hex')
  return `t=${timestampSeconds},v1=${signature}`
}
