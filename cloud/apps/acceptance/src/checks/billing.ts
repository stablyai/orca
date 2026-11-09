// Billing checks against the dev billing Worker and Stripe TEST mode (real hosted Checkout in headless
// Chrome, real webhooks to the dev Worker). Stripe objects created here are canceled/deleted after.
import { join } from 'node:path'
import { billing } from '../clients'
import type { Check, Ctx } from '../context'
import { log } from '../context'
import { CARDS, completeCheckout, stripe, type CheckoutCard } from '../stripe'
import type { Identity } from '../tokens'

const HOUR = 3600
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last = await read()
  while (!done(last) && Date.now() < deadline) {
    await sleep(2000)
    last = await read()
  }
  return last
}

const orgFor = (ctx: Ctx, tag: string): Identity => {
  const org = `w9-${ctx.run.file.runId.toLowerCase()}-${tag}`
  return { sub: `w9-owner-${tag}`, org, orgRole: 'owner', email: `eval+${org}@example.com` }
}
const entitlement = async (who: Identity) => (await billing.as(who, 'GET', '/v1/billing/entitlements')).body

async function customerFor(who: Identity): Promise<string | null> {
  const list = await stripe<{ data: Array<{ id: string; metadata: Record<string, string> }> }>('GET', '/v1/customers', { email: who.email, limit: 5 })
  return list.data.find((c) => c.metadata.account_id === `org:${who.org}`)?.id ?? null
}

/** Cancels the account's subscriptions and deletes the test customer; records both in the ledger. */
async function teardown(ctx: Ctx, who: Identity): Promise<void> {
  const customer = await customerFor(who).catch(() => null)
  if (!customer) {
    return
  }
  const subs = await stripe<{ data: Array<{ id: string; status: string }> }>('GET', '/v1/subscriptions', { customer, status: 'all' })
  for (const sub of subs.data) {
    if (!['canceled', 'incomplete_expired'].includes(sub.status)) {
      await stripe('DELETE', `/v1/subscriptions/${sub.id}`).catch(() => {})
    }
    ctx.run.destroyed('stripe_subscription', sub.id)
  }
  await stripe('DELETE', `/v1/customers/${customer}`).catch(() => {})
  ctx.run.destroyed('stripe_customer', customer)
}

async function checkoutWith(ctx: Ctx, tag: string, card: CheckoutCard, seats: number) {
  const who = orgFor(ctx, tag)
  const session = await billing.as(who, 'POST', '/v1/billing/checkout', { plan: 'team', seats, interval: 'month' })
  if (session.status !== 200 || !/^https:\/\/checkout\.stripe\.com\//.test(session.body?.url ?? '')) {
    return { who, error: `checkout ${session.status} ${JSON.stringify(session.body).slice(0, 300)}` }
  }
  const shot = join(ctx.run.artifactsDir, `checkout-${tag}.png`)
  const done = await completeCheckout(session.body.url, card, shot)
  const customer = await until(() => customerFor(who), (c) => c !== null, 30_000)
  if (customer) {
    ctx.run.created({ kind: 'stripe_customer', id: customer, label: `${card.label} checkout (${who.org})` })
  }
  const ent = await until(() => entitlement(who), (e) => e?.status === 'active')
  return { who, done, ent, customer, shot }
}

let activeTeam: Promise<Awaited<ReturnType<typeof checkoutWith>>> | null = null
const team = (ctx: Ctx) => (activeTeam ??= checkoutWith(ctx, 'card', CARDS.visa, 2))

export const billingChecks: Record<string, Check> = {
  'billing.checkout': async (ctx) => {
    const r = await team(ctx)
    if ('error' in r && r.error) {
      return { status: 'fail', detail: r.error }
    }
    const e = r.ent
    const ok = e?.status === 'active' && e.seats === 2 && e.includedSeconds === 120 * HOUR && e.canStartSandbox === true
    return {
      status: ok ? 'pass' : 'fail',
      detail: `Checkout (2 seats, ${CARDS.visa.label}) completed in ${r.done!.ms} ms -> webhook -> ${e?.status}, ${e?.seats} seats, ${(e?.includedSeconds ?? 0) / HOUR} h included, canStart=${e?.canStartSandbox}`,
      timingsMs: { checkout: r.done!.ms },
      evidence: [
        { kind: 'screenshot', label: 'card form', path: r.shot!.replace('.png', '-form.png') },
        { kind: 'screenshot', label: 'return page', path: r.shot! },
        log('entitlements', JSON.stringify(e).slice(0, 1500))
      ]
    }
  },

  'billing.checkout-3ds': async (ctx) => {
    const r = await checkoutWith(ctx, '3ds', CARDS.threeDS, 1)
    try {
      if ('error' in r && r.error) {
        return { status: 'fail', detail: r.error }
      }
      const ok = r.ent?.status === 'active'
      return {
        status: ok ? 'pass' : 'fail',
        detail: `3DS2 challenge completed in Checkout (${r.done!.ms} ms) -> ${r.ent?.status}`,
        evidence: [
          { kind: 'screenshot', label: '3DS challenge', path: r.shot!.replace('.png', '-3ds.png') },
          { kind: 'screenshot', label: 'return page', path: r.shot! }
        ]
      }
    } finally {
      await teardown(ctx, r.who)
    }
  },

  'billing.overage': async (ctx) => {
    const r = await team(ctx)
    if ('error' in r && r.error) {
      return { status: 'fail', detail: r.error }
    }
    const optIn = await billing.as(r.who, 'POST', '/v1/billing/overage', { enabled: true, spendCapCents: 5000 })
    const member = await billing.as({ ...r.who, sub: 'w9-member', orgRole: 'member' }, 'POST', '/v1/billing/overage', { enabled: false })
    const sub = (await stripe<{ data: Array<{ items: { data: Array<{ price: { id: string; recurring?: { usage_type?: string } } }> } }> }>('GET', '/v1/subscriptions', { customer: r.customer! })).data[0]
    const metered = sub?.items.data.some((i) => i.price.recurring?.usage_type === 'metered') ?? false
    const ent = await entitlement(r.who)
    const ok = optIn.status === 200 && optIn.body?.overage?.active === true && optIn.body?.overage?.spendCapCents === 5000 && member.status === 403 && metered
    return {
      status: ok ? 'partial' : 'fail',
      detail: `opt-in ${optIn.status} (active=${optIn.body?.overage?.active}, cap $${(optIn.body?.overage?.spendCapCents ?? 0) / 100}); metered item on subscription=${metered}; member toggle -> ${member.status}. Cap enforcement needs usage reports (CONTROL_PLANE_TOKEN), covered by billing e2e-test-mode.ts.`,
      evidence: [log('overage', JSON.stringify(ent?.overage ?? optIn.body).slice(0, 800))]
    }
  },

  'billing.seat-proration': async () => ({
    status: 'not_landed',
    detail: 'Seats follow Orca Cloud auth membership (POST /v1/internal/seats, MEMBERSHIP_SYNC_TOKEN); auth not deployed and the eval has no membership token yet — waiting on team-billing-ux'
  }),

  'billing.dunning': async () => ({
    status: 'not_landed',
    detail: 'Needs CONTROL_PLANE_TOKEN + D1 account link for the test-clock flow (billing e2e-test-mode.ts covers it); eval wiring pending — waiting on team-billing-ux'
  }),

  'team.create': async () => ({ status: 'not_landed', detail: 'Orgs live in Orca Cloud auth (login.onorca.dev); team endpoints merged but not deployed — waiting on team-billing-ux' }),
  'team.invite': async () => ({ status: 'not_landed', detail: 'Invites live in Orca Cloud auth; not deployed — waiting on team-billing-ux' }),

  /** Not a catalog row: tears down the shared Team checkout at the end of the billing checks. */
  'billing.teardown': async (ctx) => {
    if (activeTeam) {
      const r = await activeTeam
      await teardown(ctx, r.who)
    }
    return { status: 'pass', detail: 'test customers deleted' }
  }
}
