// Billing checks against the dev billing Worker and Stripe TEST mode (real hosted Checkout in headless
// Chrome, real webhooks to the dev Worker). Stripe objects created here are canceled/deleted after.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { billing } from '../clients'
import { secrets } from '../env'
import type { Check, Ctx } from '../context'
import { log } from '../context'
import { CARDS, completeCheckout, stripe, type CheckoutCard } from '../stripe'
import type { Identity } from '../tokens'

const HOUR = 3600
const TEAM_MONTHLY_PRICE = 'price_1UZmKpKb73TzRkjk33aiB2th' // wrangler.dev.jsonc STRIPE_PRICE_TEAM_MONTHLY
const BILLING_DIR = new URL('../../../billing/', import.meta.url).pathname

/** Test-clock customers are created by us, so link them to the account in the dev billing D1. */
function linkBillingAccount(accountId: string, customer: string): void {
  if (!/^[A-Za-z0-9_:.-]+$/.test(accountId + customer)) {
    throw new Error('unsafe id')
  }
  const now = Date.now()
  execFileSync(
    `${BILLING_DIR}node_modules/.bin/wrangler`,
    ['d1', 'execute', 'BILLING_DB', '-c', 'wrangler.dev.jsonc', '--remote', '--command',
      `INSERT INTO billing_accounts (account_id, stripe_customer_id, created_at, updated_at) VALUES ('${accountId}', '${customer}', ${now}, ${now})`],
    { cwd: BILLING_DIR, stdio: 'ignore', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } }
  )
}

async function advanceClock(clock: string, to: number): Promise<void> {
  await stripe('POST', `/v1/test_helpers/test_clocks/${clock}/advance`, { frozen_time: Math.floor(to) })
  await until(() => stripe('GET', `/v1/test_helpers/test_clocks/${clock}`), (c: any) => c.status === 'ready', 180_000)
}
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

  'billing.seat-proration': async (ctx) => {
    const token = secrets.membershipToken()
    if (!token) {
      return { status: 'skipped', detail: 'no membership sync token' }
    }
    const r = await team(ctx)
    if ('error' in r && r.error) {
      return { status: 'fail', detail: r.error }
    }
    const accountId = `org:${r.who.org}`
    const push = (members: number) => billing.raw('POST', '/v1/internal/seats', token, { accountId, members })
    const sub = async () => (await stripe('GET', '/v1/subscriptions', { customer: r.customer!, limit: 1 })).data[0]
    const seatQty = async () => (await sub())?.items.data.find((i: any) => i.price.recurring?.usage_type !== 'metered')?.quantity
    const added = await push(3)
    const qtyAfterAdd = await seatQty()
    const invoice = (await stripe('GET', '/v1/invoices', { subscription: (await sub()).id, limit: 1 })).data[0]
    const removed = await push(2)
    const qtyAfterRemove = await seatQty()
    const ent = await entitlement(r.who)
    const same = await push(2)
    const ok =
      added.body?.status === 'updated' && qtyAfterAdd === 3 && invoice?.billing_reason === 'subscription_update' && invoice?.status === 'paid' &&
      removed.body?.status === 'deferred' && qtyAfterRemove === 3 && removed.body?.effectiveAt > Date.now() && same.body?.status === 'deferred'
    return {
      status: ok ? 'pass' : 'fail',
      detail: `member added -> ${qtyAfterAdd} seats, proration invoice ${invoice?.billing_reason}/${invoice?.status} $${((invoice?.amount_paid ?? 0) / 100).toFixed(2)} charged now; member removed -> ${removed.body?.status} until ${removed.body?.effectiveAt ? new Date(removed.body.effectiveAt).toISOString().slice(0, 10) : '?'} (peak-seat billing: paid seat kept to period end, no mid-period refund abuse), still ${qtyAfterRemove} seats / entitlements ${ent?.seats}; repeat push -> ${same.body?.status}`,
      evidence: [log('seat pushes', JSON.stringify({ added: added.body, removed: removed.body, same: same.body }))]
    }
  },

  'billing.dunning': async (ctx) => {
    const cp = secrets.controlPlaneToken()
    if (!cp) {
      return { status: 'skipped', detail: 'no control-plane token' }
    }
    const who = orgFor(ctx, 'dunning')
    const accountId = `org:${who.org}`
    const startCheck = async () =>
      (await billing.raw('POST', '/v1/internal/entitlements/check', cp, { accountId, machineSize: 'standard', runningSandboxes: 0 })).body
    const clock = await stripe('POST', '/v1/test_helpers/test_clocks', { frozen_time: Math.floor(Date.now() / 1000), name: `orca-acceptance-${ctx.run.file.runId}` })
    ctx.run.created({ kind: 'stripe_test_clock', id: clock.id, label: 'dunning clock' })
    const customer = await stripe('POST', '/v1/customers', { email: who.email, test_clock: clock.id, metadata: { account_id: accountId } })
    ctx.run.created({ kind: 'stripe_customer', id: customer.id, label: 'dunning customer (test clock)' })
    try {
      linkBillingAccount(accountId, customer.id)
      const visa = await stripe('POST', '/v1/payment_methods/pm_card_visa/attach', { customer: customer.id })
      await stripe('POST', `/v1/customers/${customer.id}`, { invoice_settings: { default_payment_method: visa.id } })
      const sub = await stripe('POST', '/v1/subscriptions', { customer: customer.id, items: [{ price: TEAM_MONTHLY_PRICE, quantity: 1 }], metadata: { account_id: accountId } })
      const active = await until(() => entitlement(who), (e) => e?.status === 'active')
      const failing = await stripe('POST', '/v1/payment_methods/pm_card_chargeCustomerFail/attach', { customer: customer.id })
      await stripe('POST', `/v1/customers/${customer.id}`, { invoice_settings: { default_payment_method: failing.id } })
      await advanceClock(clock.id, active.period.end / 1000 + HOUR)
      const pastDue = await until(() => entitlement(who), (e) => e?.status === 'past_due', 150_000)
      const blocked = await startCheck()
      const graceH = pastDue?.payment ? (pastDue.payment.graceEndsAt - pastDue.payment.pastDueSince) / 3_600_000 : null
      // Pay the open invoice with a good card -> active -> starts allowed again.
      const good = await stripe('POST', '/v1/payment_methods/pm_card_visa/attach', { customer: customer.id })
      await stripe('POST', `/v1/customers/${customer.id}`, { invoice_settings: { default_payment_method: good.id } })
      const live = await stripe('GET', `/v1/subscriptions/${sub.id}`)
      await stripe('POST', `/v1/invoices/${live.latest_invoice}/pay`, { payment_method: good.id })
      const resumed = await until(startCheck, (c) => c?.allow === true, 120_000)
      const ok = pastDue?.status === 'past_due' && blocked?.allow === false && resumed?.allow === true && resumed?.suspendRunning === false
      return {
        status: ok ? 'partial' : 'fail',
        detail: `test clock renewal with a failing card -> ${pastDue?.status} (reason ${pastDue?.reason}); new starts ${blocked?.allow === false ? 'blocked' : 'ALLOWED'}; grace ${graceH} h before running sandboxes are suspended (expiry not waited on the dev Worker); paid -> starts ${resumed?.allow ? 'allowed' : 'still blocked'}, suspendRunning=${resumed?.suspendRunning}`,
        evidence: [log('past_due entitlements', JSON.stringify(pastDue).slice(0, 1500))]
      }
    } finally {
      await stripe('DELETE', `/v1/customers/${customer.id}`).catch(() => {})
      ctx.run.destroyed('stripe_customer', customer.id)
      await stripe('DELETE', `/v1/test_helpers/test_clocks/${clock.id}`).catch(() => {})
      ctx.run.destroyed('stripe_test_clock', clock.id)
    }
  },

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
