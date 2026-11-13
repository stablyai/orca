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
  cancel_at?: number | null
  livemode: boolean
  metadata: Record<string, string>
  items: { object: 'list'; data: FakeItem[] }
}

type FakePrice = {
  id: string
  object?: 'price'
  active?: boolean
  livemode?: boolean
  currency?: string
  unit_amount?: number | null
  unit_amount_decimal?: string | null
  lookup_key?: string | null
  metadata?: Record<string, string>
  product?: string
  recurring: { interval?: string; usage_type: 'licensed' | 'metered' }
}

type FakeItem = {
  id: string
  quantity?: number
  current_period_start: number
  current_period_end: number
  price: FakePrice
}

/** The test-mode catalog the harness env names (STRIPE_PRICE_*), like stripe-test-setup.ts makes. */
export function defaultFakePrices(): FakePrice[] {
  return [
    { id: 'price_team_month', active: true, currency: 'usd', unit_amount: 5000, unit_amount_decimal: '5000', lookup_key: 'orca_team_seat_monthly', metadata: { orca_plan: 'team' }, product: 'prod_team', recurring: { interval: 'month', usage_type: 'licensed' } },
    { id: 'price_team_year', active: true, currency: 'usd', unit_amount: 48000, unit_amount_decimal: '48000', lookup_key: 'orca_team_seat_annual', metadata: { orca_plan: 'team' }, product: 'prod_team', recurring: { interval: 'year', usage_type: 'licensed' } },
    { id: 'price_overage', active: true, currency: 'usd', unit_amount: null, unit_amount_decimal: '1.666666666667', lookup_key: 'orca_sandbox_overage_per_minute', product: 'prod_overage', recurring: { interval: 'month', usage_type: 'metered' } }
  ]
}

export type RecordedCall = { method: string; path: string; form: URLSearchParams; headers: Headers }

export function createFakeStripe() {
  const calls: RecordedCall[] = []
  const customers = new Map<string, { id: string; metadata: Record<string, string> }>()
  const subscriptions = new Map<string, FakeSubscription>()
  const idempotent = new Map<string, unknown>()
  const checkoutSessions = new Map<string, { id: string; customer: string; status: string }>()
  const meterEvents: Array<Record<string, string>> = []
  const prices = new Map(defaultFakePrices().map((price) => [price.id, price]))
  // Stripe's event log (newest last here; listed newest first like Stripe).
  const events: Array<{ id: string; type: string; created: number; livemode: boolean; data: { object: Record<string, unknown> } }> = []
  let nextId = 1
  const priceFor = (id: string, usage: 'licensed' | 'metered'): FakePrice =>
    structuredClone(prices.get(id) ?? { id, recurring: { usage_type: usage } })
  let failMeterEvents = 0
  let failSubscriptionCancels = 0
  const cancelParams: Array<Record<string, string>> = []

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
      checkoutSessions.set(id, { id, customer: form.get('customer') ?? '', status: 'open' })
      return respond({ id, object: 'checkout.session', url: `https://checkout.stripe.com/c/pay/${id}` })
    }
    if (method === 'GET' && url.pathname === '/v1/checkout/sessions') {
      const customer = url.searchParams.get('customer')
      const status = url.searchParams.get('status')
      return Response.json({
        data: [...checkoutSessions.values()].filter(
          (session) => (!customer || session.customer === customer) && (!status || session.status === status)
        )
      })
    }
    const expire = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(url.pathname)
    if (method === 'POST' && expire) {
      const session = checkoutSessions.get(decodeURIComponent(expire[1]!))
      if (!session || session.status !== 'open') {
        return Response.json({ error: { code: 'checkout_session_not_open', message: 'not open' } }, { status: 400 })
      }
      session.status = 'expired'
      return respond(session)
    }
    if (method === 'POST' && url.pathname === '/v1/billing_portal/sessions') {
      const id = `bps_test_${nextId++}`
      return respond({ id, url: `https://billing.stripe.com/p/session/${id}` })
    }
    if (method === 'GET' && url.pathname === '/v1/prices') {
      const keys = [...url.searchParams.entries()].filter(([name]) => name.startsWith('lookup_keys')).map(([, value]) => value)
      return Response.json({
        object: 'list',
        data: [...prices.values()].filter((price) => price.active !== false && price.lookup_key && keys.includes(price.lookup_key))
      })
    }
    if (method === 'GET' && url.pathname === '/v1/events') {
      const types = [...url.searchParams.entries()].filter(([name]) => name.startsWith('types')).map(([, value]) => value)
      const before = url.searchParams.get('ending_before')
      const limit = Number(url.searchParams.get('limit') ?? '10')
      const matching = events.filter((event) => types.length === 0 || types.includes(event.type))
      let page: typeof matching
      if (before) {
        const index = matching.findIndex((event) => event.id === before)
        // The `limit` events right after the cursor (oldest of the newer ones first), newest first.
        page = (index < 0 ? [] : matching.slice(index + 1, index + 1 + limit)).reverse()
        return Response.json({ object: 'list', data: page, has_more: index >= 0 && matching.length > index + 1 + limit })
      }
      page = matching.slice(-limit).reverse()
      return Response.json({ object: 'list', data: page, has_more: matching.length > limit })
    }
    if (method === 'DELETE' && url.pathname.startsWith('/v1/subscriptions/')) {
      if (failSubscriptionCancels > 0) {
        failSubscriptionCancels--
        return Response.json({ error: { message: 'temporarily unavailable' } }, { status: 503 })
      }
      const subscription = subscriptions.get(decodeURIComponent(url.pathname.slice('/v1/subscriptions/'.length)))
      if (!subscription || subscription.status === 'canceled') {
        return Response.json({ error: { code: 'resource_missing', message: 'No such subscription' } }, { status: 404 })
      }
      cancelParams.push(Object.fromEntries(url.searchParams))
      subscription.status = 'canceled'
      subscription.cancel_at = null
      subscription.cancel_at_period_end = false
      return Response.json(subscription)
    }
    if (method === 'GET' && url.pathname.startsWith('/v1/subscriptions/')) {
      const subscription = subscriptions.get(decodeURIComponent(url.pathname.slice('/v1/subscriptions/'.length)))
      return subscription
        ? Response.json(subscription)
        : Response.json({ error: { code: 'resource_missing', message: 'No such subscription' } }, { status: 404 })
    }
    if (method === 'POST' && url.pathname.startsWith('/v1/subscription_items/')) {
      const itemId = decodeURIComponent(url.pathname.slice('/v1/subscription_items/'.length))
      for (const subscription of subscriptions.values()) {
        const item = subscription.items.data.find((entry) => entry.id === itemId)
        if (item && form.has('price')) {
          item.price = priceFor(form.get('price')!, 'metered')
          return respond({ id: item.id, price: item.price })
        }
        if (item) {
          item.quantity = Number(form.get('quantity'))
          return respond({ id: item.id, quantity: item.quantity })
        }
      }
      return Response.json({ error: { code: 'resource_missing', message: 'No such item' } }, { status: 404 })
    }
    if (method === 'DELETE' && url.pathname.startsWith('/v1/subscription_items/')) {
      const itemId = decodeURIComponent(url.pathname.slice('/v1/subscription_items/'.length))
      for (const subscription of subscriptions.values()) {
        const index = subscription.items.data.findIndex((entry) => entry.id === itemId)
        if (index >= 0) {
          subscription.items.data.splice(index, 1)
          return Response.json({ id: itemId, object: 'subscription_item', deleted: true })
        }
      }
      return Response.json({ error: { code: 'resource_missing', message: 'No such item' } }, { status: 404 })
    }
    if (method === 'POST' && url.pathname === '/v1/subscription_items') {
      const subscription = subscriptions.get(form.get('subscription') ?? '')
      if (!subscription) {
        return Response.json({ error: { code: 'resource_missing', message: 'No such subscription' } }, { status: 404 })
      }
      const base = subscription.items.data[0]!
      const item: FakeItem = {
        id: `si_test_${nextId++}`,
        price: priceFor(form.get('price') ?? '', 'metered'),
        current_period_start: base.current_period_start,
        current_period_end: base.current_period_end
      }
      subscription.items.data.push(item)
      return respond(item)
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
    prices,
    events,
    /** Stripe records an event (whether or not its webhook is delivered). */
    recordEvent(event: { id: string; type: string; created: number; livemode: boolean; data: { object: Record<string, unknown> } }) {
      events.push(event)
    },
    cancelParams,
    failNextSubscriptionCancels(count: number) {
      failSubscriptionCancels = count
    },
    failNextMeterEvents(count: number) {
      failMeterEvents = count
    },
    /** What Stripe holds after Checkout completes for `customer` (the test plays the browser). */
    putSubscription(args: {
      customer: string
      accountId: string
      basePrice: string
      /** Metered overage items already on the subscription (e.g. an older overage price). */
      overagePrice?: string | string[]
      quantity?: number
      status?: string
      periodStart: number
      periodEnd: number
      livemode?: boolean
    }): FakeSubscription {
      const id = `sub_test_${nextId++}`
      const period = { current_period_start: args.periodStart, current_period_end: args.periodEnd }
      const data: FakeSubscription['items']['data'] = [
        { id: `si_test_${nextId++}`, quantity: args.quantity ?? 1, price: priceFor(args.basePrice, 'licensed'), ...period }
      ]
      for (const price of [args.overagePrice ?? []].flat()) {
        data.push({ id: `si_test_${nextId++}`, price: priceFor(price, 'metered'), ...period })
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
