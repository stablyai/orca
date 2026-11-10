// Billing checks against the dev billing Worker and Stripe TEST mode (real hosted Checkout in headless
// Chrome, real webhooks to the dev Worker). Stripe objects created here are canceled/deleted after.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { billing, control } from '../clients'
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
      `INSERT INTO billing_accounts (account_id, stripe_customer_id, created_at, updated_at) VALUES ('${accountId}', '${customer}', ${now}, ${now}) ON CONFLICT (account_id) DO UPDATE SET stripe_customer_id = excluded.stripe_customer_id, updated_at = excluded.updated_at`],
    { cwd: BILLING_DIR, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } }
  )
}

function d1(dir: string, binding: string, sql: string): any[] {
  const out = execFileSync(`${dir}node_modules/.bin/wrangler`, ['d1', 'execute', binding, '-c', 'wrangler.dev.jsonc', '--remote', '--json', '--command', sql], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' }
  })
  return (JSON.parse(out.slice(out.indexOf('['))) as Array<{ results: any[] }>)[0]?.results ?? []
}
const d1Billing = (sql: string) => d1(BILLING_DIR, 'BILLING_DB', sql)
const d1Control = (sql: string) => d1(new URL('../../../sandbox-control/', import.meta.url).pathname, 'SANDBOX_DB', sql)

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
    // Cap enforcement: lower the cap to $5 (6.7 overage hours), report 120 included + 8 h, expect starts blocked.
    const cp = secrets.controlPlaneToken()
    let capped: any = null
    let capSpent: number | null = null
    if (cp) {
      await billing.as(r.who, 'POST', '/v1/billing/overage', { enabled: true, spendCapCents: 500 })
      const accountId = `org:${r.who.org}`
      const end = Date.now() - 60_000
      for (let i = 0; i < 6; i++) {
        const hours = i < 5 ? 24 : 8
        const endedAt = end - (10 + i) * 25 * HOUR * 1000
        await billing.raw('POST', '/v1/internal/usage', cp, {
          usageId: `w9-cap-${ctx.run.file.runId}-${i}`,
          accountId,
          sandboxId: `sbx-w9cap-${ctx.run.file.runId}`,
          machineSize: 'standard',
          startedAt: endedAt - hours * HOUR * 1000,
          endedAt
        })
      }
      capped = (await billing.raw('POST', '/v1/internal/entitlements/check', cp, { accountId, machineSize: 'standard', runningSandboxes: 0 })).body
      capSpent = (await entitlement(r.who))?.overage?.spentCents ?? null
      // Restore the default cap for later checks.
      await billing.as(r.who, 'POST', '/v1/billing/overage', { enabled: true, spendCapCents: 5000 })
    }
    const capOk = capped?.allow === false && capped?.reason === 'overage_cap_reached' && capSpent !== null && capSpent <= 500
    const ok = optIn.status === 200 && optIn.body?.overage?.active === true && optIn.body?.overage?.spendCapCents === 5000 && member.status === 403 && metered && capOk
    return {
      status: ok ? 'pass' : 'fail',
      detail: `opt-in ${optIn.status} (active=${optIn.body?.overage?.active}, cap $${(optIn.body?.overage?.spendCapCents ?? 0) / 100}); metered item on subscription=${metered}; member toggle -> ${member.status}; with a $5 cap and 128 h used: new starts ${capped?.allow === false ? 'blocked' : 'ALLOWED'} (${capped?.reason}), metered spend stopped at $${((capSpent ?? 0) / 100).toFixed(2)}`,
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
      added.body?.status === 'increased' && qtyAfterAdd === 3 && invoice?.billing_reason === 'subscription_update' && invoice?.status === 'paid' &&
      removed.body?.status === 'deferred' && qtyAfterRemove === 3 && removed.body?.effectiveAt > Date.now() && same.body?.status === 'deferred'
    return {
      status: ok ? 'pass' : 'fail',
      detail: `member added -> ${qtyAfterAdd} seats, proration invoice ${invoice?.billing_reason}/${invoice?.status} $${((invoice?.amount_paid ?? 0) / 100).toFixed(2)} charged now; member removed -> ${removed.body?.status} until ${removed.body?.effectiveAt ? new Date(removed.body.effectiveAt).toISOString().slice(0, 10) : '?'} (peak-seat billing: paid seat kept to period end, no mid-period refund abuse), still ${qtyAfterRemove} seats / entitlements ${ent?.seats}; repeat push -> ${same.body?.status}`,
      evidence: [log('seat pushes', JSON.stringify({ added: added.body, removed: removed.body, same: same.body }))]
    }
  },

  'billing.dunning': async (ctx) => {
    // Full payment-failure path on real systems: Stripe test clock renewal with a failing card ->
    // past_due -> grace expiry (past_due_since backdated 97 h in the dev billing D1 instead of
    // waiting 96 h) -> billing lists the account -> the control-plane cron suspends its RUNNING
    // sandbox -> pay the invoice -> starts allowed -> the sandbox resumes. The billing account id is
    // the control plane's dev org account, so both services talk about one account.
    const cp = secrets.controlPlaneToken()
    if (!cp) {
      return { status: 'skipped', detail: 'no control-plane token' }
    }
    const tag = ctx.run.file.runId.replace(/[^0-9]/g, '').slice(-8)
    const org = `w9dun${tag}`
    const accountId = `dev:org:${org}`
    const owner = { sub: `w9-dun-${tag}`, org, orgRole: 'owner' as const }
    const email = `eval+${org}@example.com`
    const startCheck = async () =>
      (await billing.raw('POST', '/v1/internal/entitlements/check', cp, { accountId, machineSize: 'standard', runningSandboxes: 0 })).body
    const listedNow = async () =>
      JSON.stringify((await billing.raw('GET', '/v1/internal/suspensions', cp)).body ?? '').includes(accountId)
    const clock = await stripe('POST', '/v1/test_helpers/test_clocks', { frozen_time: Math.floor(Date.now() / 1000), name: `orca-acceptance-${ctx.run.file.runId}` })
    ctx.run.created({ kind: 'stripe_test_clock', id: clock.id, label: 'dunning clock' })
    const customer = await stripe('POST', '/v1/customers', { email, test_clock: clock.id, metadata: { account_id: accountId } })
    ctx.run.created({ kind: 'stripe_customer', id: customer.id, label: 'dunning customer (test clock)' })
    let sandboxId: string | null = null
    try {
      linkBillingAccount(accountId, customer.id)
      const visa = await stripe('POST', '/v1/payment_methods/pm_card_visa/attach', { customer: customer.id })
      await stripe('POST', `/v1/customers/${customer.id}`, { invoice_settings: { default_payment_method: visa.id } })
      const sub = await stripe('POST', '/v1/subscriptions', { customer: customer.id, items: [{ price: TEAM_MONTHLY_PRICE, quantity: 1 }], metadata: { account_id: accountId } })
      const activeCheck = await until(startCheck, (c: any) => c?.allow === true, 120_000)
      const box = await ctx.sandboxes.create(owner, { workspaceId: `w9-dun-${tag}` })
      sandboxId = box.status === 200 ? box.body.sandbox.id : null
      const failing = await stripe('POST', '/v1/payment_methods/pm_card_chargeCustomerFail/attach', { customer: customer.id })
      await stripe('POST', `/v1/customers/${customer.id}`, { invoice_settings: { default_payment_method: failing.id } })
      const live0 = await stripe('GET', `/v1/subscriptions/${sub.id}`)
      const periodEnd = (live0.items?.data?.[0]?.current_period_end ?? live0.current_period_end) as number
      await advanceClock(clock.id, periodEnd + HOUR)
      const pastDue = await until(startCheck, (c: any) => c?.reason === 'payment_past_due', 150_000)
      // Grace expiry without waiting 96 h: backdate when billing first saw past_due.
      d1Billing(`UPDATE subscriptions SET past_due_since = ${Date.now() - 97 * HOUR * 1000} WHERE account_id = '${accountId}'`)
      const expired = await startCheck()
      const listed = await listedNow()
      // The control-plane cron (every minute) suspends the account's running sandboxes.
      let suspendedAfterMs: number | null = null
      const t0 = Date.now()
      while (sandboxId && Date.now() - t0 < 4 * 60_000) {
        const v = await control.as(owner, 'GET', `/v1/sandboxes/${sandboxId}`)
        if (v.body?.sandbox?.status === 'suspended') {
          suspendedAfterMs = Date.now() - t0
          break
        }
        await sleep(10_000)
      }
      // Pay -> allowed -> resume.
      const good = await stripe('POST', '/v1/payment_methods/pm_card_visa/attach', { customer: customer.id })
      await stripe('POST', `/v1/customers/${customer.id}`, { invoice_settings: { default_payment_method: good.id } })
      const live = await stripe('GET', `/v1/subscriptions/${sub.id}`)
      await stripe('POST', `/v1/invoices/${live.latest_invoice}/pay`, { payment_method: good.id })
      const paid = await until(startCheck, (c: any) => c?.allow === true && c?.suspendRunning === false, 120_000)
      const delisted = !(await listedNow())
      const resumed = sandboxId ? await control.as(owner, 'POST', `/v1/sandboxes/${sandboxId}/resume`) : null
      const ok =
        activeCheck?.allow === true && pastDue?.allow === false && expired?.suspendRunning === true && expired?.reason === 'payment_grace_expired' &&
        listed && suspendedAfterMs !== null && paid?.allow === true && delisted && resumed?.status === 200
      return {
        status: ok ? 'pass' : 'fail',
        detail: `active -> test-clock renewal with a failing card -> past_due (new starts ${pastDue?.allow === false ? 'blocked' : 'ALLOWED'}); past_due_since backdated 97 h -> ${expired?.reason}, suspendRunning=${expired?.suspendRunning}, listed in /v1/internal/suspensions=${listed}; control-plane cron suspended the running sandbox ${suspendedAfterMs !== null ? `after ${Math.round(suspendedAfterMs / 1000)} s` : 'NOT within 4 min'}; invoice paid -> allow=${paid?.allow}, delisted=${delisted}; resume ${resumed?.status}`,
        ...(suspendedAfterMs !== null ? { timingsMs: { cronSuspend: suspendedAfterMs } } : {})
      }
    } finally {
      if (sandboxId) {
        await ctx.sandboxes.destroy(sandboxId).catch(() => null)
      }
      await stripe('DELETE', `/v1/customers/${customer.id}`).catch(() => {})
      ctx.run.destroyed('stripe_customer', customer.id)
      await stripe('DELETE', `/v1/test_helpers/test_clocks/${clock.id}`).catch(() => {})
      ctx.run.destroyed('stripe_test_clock', clock.id)
    }
  },

  'ops.usage': async (ctx) => {
    // (1) The control plane meters each session segment into its outbox (dev accounts are not sent
    //     to billing outside prod); (2) billing turns reported segments into hours used and, past
    //     the included hours with overage on, into Stripe meter events.
    const cp = secrets.controlPlaneToken()
    if (!cp) {
      return { status: 'skipped', detail: 'no control-plane token' }
    }
    const box = await ctx.sandboxes.create(ctx.solo, { workspaceId: `w9-usage-${ctx.run.file.runId}` })
    if (box.status !== 200) {
      return { status: 'fail', detail: `create ${box.status}` }
    }
    await sleep(20_000)
    await ctx.sandboxes.suspend(box.body.sandbox.id)
    const rows = d1Control(`SELECT started_at, ended_at, sent_at FROM usage_outbox WHERE sandbox_id = '${box.body.sandbox.id}'`)
    const meteredMs = rows.reduce((sum: number, r: any) => sum + (r.ended_at - r.started_at), 0)
    await ctx.sandboxes.destroy(box.body.sandbox.id)
    const r = await team(ctx)
    if ('error' in r && r.error) {
      return { status: 'fail', detail: r.error }
    }
    const accountId = `org:${r.who.org}`
    const before = await entitlement(r.who)
    await billing.as(r.who, 'POST', '/v1/billing/overage', { enabled: true, spendCapCents: 5000 })
    const now = Date.now() - 60_000
    let posted = 0
    for (let i = 0; i < 6; i++) {
      // 5 x 24 h fills the 120 included hours of a 2-seat team; the 6th adds 2 h of overage.
      const hours = i < 5 ? 24 : 2
      const endedAt = now - i * 25 * HOUR * 1000
      const u = await billing.raw('POST', '/v1/internal/usage', cp, {
        usageId: `w9-${ctx.run.file.runId}-${i}`,
        accountId,
        sandboxId: `sbx-w9-${ctx.run.file.runId}`,
        machineSize: 'standard',
        startedAt: endedAt - hours * HOUR * 1000,
        endedAt
      })
      posted += u.status === 200 ? 1 : 0
    }
    const after = await entitlement(r.who)
    const meterId = (await stripe('GET', '/v1/billing/meters', { limit: 20 })).data.find((m: any) => m.event_name === 'orca_sandbox_seconds')?.id
    const start = Math.floor((now - 7 * 24 * HOUR * 1000) / 60_000) * 60
    const summed = meterId
      ? await until(
          async () =>
            (await stripe('GET', `/v1/billing/meters/${meterId}/event_summaries`, { customer: r.customer!, start_time: start, end_time: Math.ceil(Date.now() / 60_000) * 60 + 60 })).data.reduce(
              (sum: number, x: any) => sum + x.aggregated_value,
              0
            ),
          (v: number) => v >= 2 * HOUR,
          240_000
        )
      : 0
    const usedH = (after?.usedSeconds ?? 0) / HOUR
    const ok = rows.length > 0 && meteredMs > 10_000 && posted === 6 && usedH >= 122 && (after?.overage?.spentCents ?? 0) > 0 && summed >= 2 * HOUR
    return {
      status: ok ? 'pass' : 'fail',
      detail: `control plane metered ${rows.length} segment(s), ${Math.round(meteredMs / 1000)} s for a ~20 s session (outbox sent=${rows.every((x: any) => x.sent_at)}); billing: 6 segments -> used ${usedH.toFixed(1)} h of ${((after?.includedSeconds ?? 0) / HOUR).toFixed(0)} included (was ${((before?.usedSeconds ?? 0) / HOUR).toFixed(1)}), overage spend $${((after?.overage?.spentCents ?? 0) / 100).toFixed(2)}; Stripe meter received ${Math.round(summed / 60)} overage minutes`
    }
  },

  /** Not a catalog row: tears down the shared Team checkout at the end of the billing checks. */
  'billing.teardown': async (ctx) => {
    if (activeTeam) {
      const r = await activeTeam
      await teardown(ctx, r.who)
    }
    return { status: 'pass', detail: 'test customers deleted' }
  }
}
