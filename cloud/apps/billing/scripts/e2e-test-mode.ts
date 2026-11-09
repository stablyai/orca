// End-to-end billing run against a running Worker (local `wrangler dev` or a dev deploy) and
// Stripe TEST MODE, with real webhooks (via `stripe listen` locally, or a test webhook endpoint).
//
//   tsx scripts/e2e-test-mode.ts keys <dir>       # local-only ES256 key + JWKS (stands in for auth)
//   tsx scripts/e2e-test-mode.ts run               # drive the flows below
//
// Env for `run`: BILLING_URL, STRIPE_SECRET_KEY (sk_test_/rk_test_ only), CONTROL_PLANE_TOKEN,
// E2E_JWK_PRIVATE (path), E2E_CATALOG (path to the stripe-test-setup.ts JSON), E2E_ISSUER,
// E2E_D1_ARGS (wrangler d1 execute target, e.g. "BILLING_DB --local").
//
// E2E_MEMBERSHIP_TOKEN (optional) enables the peak-seat checks; E2E_GRACE_SECONDS (default 96 h)
// is the Worker's payment grace (short: watched expiring; long: past_due_since backdated in D1).
//
// Flows: Checkout (2 seats, test card, headless browser) -> overage opt-in -> usage past the
// included hours -> meter events in Stripe -> spend cap blocks starts -> peak seats (add charged
// now, removal deferred, re-add free) -> annual plan + overage -> seat true-down + test-clock
// renewal -> invoice.payment_failed -> grace -> suspend -> pay -> resume -> cancel -> 3DS Checkout
// (challenge passed; 3DS-then-decline and insufficient funds create nothing) -> cleanup.
// Prints PASS/FAIL per check and the ids.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { SignJWT, exportJWK, generateKeyPair, importJWK } from 'jose'
import { encodeForm } from '../src/stripe'

const HOUR = 3600
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

if (process.argv[2] === 'keys') {
  const dir = process.argv[3]!
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true })
  writeFileSync(`${dir}/jwk-private.json`, JSON.stringify({ ...(await exportJWK(privateKey)), kid: 'e2e', alg: 'ES256' }), {
    mode: 0o600
  })
  writeFileSync(`${dir}/jwks.json`, JSON.stringify({ keys: [{ ...(await exportJWK(publicKey)), kid: 'e2e', alg: 'ES256', use: 'sig' }] }))
  console.log(`wrote ${dir}/jwk-private.json and ${dir}/jwks.json`)
  process.exit(0)
}

const env = (name: string): string => {
  const value = process.env[name]
  if (!value) {
    throw new Error(`missing ${name}`)
  }
  return value
}
const BILLING_URL = env('BILLING_URL')
const STRIPE_KEY = env('STRIPE_SECRET_KEY')
if (!STRIPE_KEY.startsWith('sk_test_') && !STRIPE_KEY.startsWith('rk_test_')) {
  throw new Error('Refusing: test-mode Stripe key required')
}
const CONTROL = env('CONTROL_PLANE_TOKEN')
const catalog = JSON.parse(readFileSync(env('E2E_CATALOG'), 'utf8')) as Record<string, string> & { meter: string }
const jwk = JSON.parse(readFileSync(env('E2E_JWK_PRIVATE'), 'utf8')) as { kid: string }
const signingKey = await importJWK(jwk, 'ES256')
const issuer = env('E2E_ISSUER')
const d1Args = env('E2E_D1_ARGS').split(' ')
const runId = Date.now().toString(36)

const results: Array<{ ok: boolean; name: string; detail: string }> = []
function check(name: string, ok: boolean, detail: unknown = ''): boolean {
  results.push({ ok, name, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  return ok
}
const ids: Record<string, string> = {}

async function token(org: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ sub: `user_${org}`, org, orgRole: 'owner', email: `e2e+${org}@example.com`, purpose: 'billing' })
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid })
    .setIssuer(issuer)
    .setAudience('orca-billing')
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(signingKey)
}

async function billing(method: string, path: string, org: string | null, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  headers.authorization = `Bearer ${org ? await token(org) : CONTROL}`
  const response = await fetch(`${BILLING_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, any> }
}

async function stripe<T = Record<string, any>>(method: 'GET' | 'POST' | 'DELETE', path: string, params?: Record<string, unknown>): Promise<T> {
  const url = new URL(`https://api.stripe.com${path}`)
  if (method !== 'POST' && params) {
    url.search = encodeForm(params as never)
  }
  const response = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${STRIPE_KEY}`, 'content-type': 'application/x-www-form-urlencoded', 'stripe-version': '2025-09-30.clover' },
    body: method === 'POST' ? encodeForm((params ?? {}) as never) : undefined
  })
  const json = (await response.json()) as T & { livemode?: boolean; error?: { message: string } }
  if (!response.ok) {
    throw new Error(`stripe ${method} ${path}: ${json.error?.message}`)
  }
  if (json.livemode) {
    throw new Error('live-mode object returned; aborting')
  }
  return json
}

async function until<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last = await read()
  while (!done(last) && Date.now() < deadline) {
    await sleep(2000)
    last = await read()
  }
  if (!done(last)) {
    console.log(`  (timed out waiting for ${what})`)
  }
  return last
}

const entitlement = (org: string) => billing('GET', '/v1/billing/entitlements', org).then((r) => r.body)
const startCheck = (accountId: string) =>
  billing('POST', '/v1/internal/entitlements/check', null, { accountId, machineSize: 'standard', runningSandboxes: 0 }).then((r) => r.body)
let usageCounter = 0
async function reportUsage(accountId: string, hours: number) {
  const endedAt = Date.now() - 60_000 - usageCounter * 1000
  usageCounter++
  return billing('POST', '/v1/internal/usage', null, {
    usageId: `e2e-${runId}-${usageCounter}`,
    accountId,
    sandboxId: `sbx-${runId}`,
    machineSize: 'standard',
    startedAt: endedAt - hours * HOUR * 1000,
    endedAt
  }).then((r) => r.body)
}

function linkAccount(accountId: string, customer: string) {
  if (!/^[A-Za-z0-9_:.-]+$/.test(accountId + customer)) {
    throw new Error('unsafe id')
  }
  const now = Date.now()
  d1(`INSERT INTO billing_accounts (account_id, stripe_customer_id, created_at, updated_at) VALUES ('${accountId}', '${customer}', ${now}, ${now})`)
}

function d1(sql: string) {
  execFileSync('npx', ['wrangler', 'd1', 'execute', ...d1Args, '--command', sql], { stdio: 'ignore', env: { ...process.env, CI: '1' } })
}

// Stripe's test 3DS challenge sits in nested iframes; press "Complete" (or "Fail") wherever it shows.
async function answer3ds(page: import('playwright-core').Page, action: 'complete' | 'fail', timeoutMs = 60_000): Promise<boolean> {
  const selector = action === 'complete' ? '#test-source-authorize-3ds' : '#test-source-fail-3ds'
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      // The test ACS page's button ids aren't always present; its labels are COMPLETE / FAIL.
      const button = frame.locator(selector).or(frame.getByRole('button', { name: action === 'complete' ? /^complete$/i : /^fail$/i }))
      if (await button.count().catch(() => 0)) {
        await button.first().click()
        return true
      }
    }
    await sleep(1000)
  }
  return false
}

type CheckoutOutcome = { success: boolean; challenged: boolean; error: string }

async function completeCheckout(
  url: string,
  card = '4242424242424242',
  { threeDS, expectSuccess = true }: { threeDS?: 'complete' | 'fail'; expectSuccess?: boolean } = {}
): Promise<CheckoutOutcome> {
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.locator('#cardNumber').waitFor({ timeout: 60_000 })
    await page.fill('#cardNumber', card)
    await page.fill('#cardExpiry', '12/34')
    await page.fill('#cardCvc', '123')
    if (await page.locator('#billingName').count()) {
      await page.fill('#billingName', 'Orca E2E')
    }
    if (await page.locator('#billingPostalCode').count()) {
      await page.fill('#billingPostalCode', '94107')
    }
    // Opting out of "Save my information with Link" (it would require a phone number).
    const link = page.locator('#enableStripePass')
    if ((await link.count()) && (await link.isChecked())) {
      await link.uncheck({ force: true })
    }
    await page.locator('[data-testid="hosted-payment-submit-button"], .SubmitButton').first().click()
    const challenged = threeDS ? await answer3ds(page, threeDS) : false
    const succeeded = page
      // 'commit': /return hands off to orca:// via meta refresh, so "load" may never fire headless.
      .waitForURL((current) => current.searchParams.get('checkout') === 'success', { timeout: 90_000, waitUntil: 'commit' })
      .then(() => true)
    // Settles to false on timeout so the decline path never leaves a rejection unhandled.
    const redirect = succeeded.catch(() => false)
    if (!expectSuccess) {
      // A decline keeps the buyer on Checkout with an inline error; no redirect may follow.
      const error = page.locator('.FieldError, [role="alert"], .ConfirmPaymentButton-error, [data-testid="error-message"]')
      await error.filter({ hasText: /\S/ }).first().waitFor({ timeout: 90_000 }).catch(() => undefined)
      const redirected = await Promise.race([redirect, sleep(10_000).then(() => false)])
      const text = (await error.allInnerTexts().catch(() => [])).join(' ').replace(/\s+/g, ' ').trim()
      if (!text && process.env.E2E_SCREENSHOT_DIR) {
        await page.screenshot({ path: `${process.env.E2E_SCREENSHOT_DIR}/checkout-decline-${card.slice(-4)}.png`, fullPage: true })
      }
      return { success: redirected, challenged, error: text }
    }
    // A missed redirect fails the caller's checks (and still reaches cleanup) instead of aborting the run.
    if (!(await redirect)) {
      if (process.env.E2E_SCREENSHOT_DIR) {
        await page.screenshot({ path: `${process.env.E2E_SCREENSHOT_DIR}/checkout-failure.png`, fullPage: true })
      }
      return { success: false, challenged, error: 'no redirect to /return?checkout=success' }
    }
    return { success: true, challenged, error: '' }
  } finally {
    await browser.close()
  }
}

async function advanceClock(clock: string, to: number) {
  await stripe('POST', `/v1/test_helpers/test_clocks/${clock}/advance`, { frozen_time: to })
  await until('test clock ready', () => stripe('GET', `/v1/test_helpers/test_clocks/${clock}`), (c) => c.status === 'ready', 180_000)
}

// ---- 1. Checkout, 2 seats, test card ----------------------------------------------------------
const orgA = `e2e-${runId}-a`
const accountA = `org:${orgA}`
const checkout = await billing('POST', '/v1/billing/checkout', orgA, { plan: 'team', seats: 2, interval: 'month' })
check('checkout session created (hosted Stripe URL)', checkout.status === 200 && /^https:\/\/checkout\.stripe\.com\//.test(checkout.body.url), checkout)
await completeCheckout(checkout.body.url)
const afterCheckout = await until('active subscription', () => entitlement(orgA), (e) => e.status === 'active')
check('webhook -> 2-seat Team active, 120 h included, 6 concurrent', afterCheckout.status === 'active' && afterCheckout.seats === 2 &&
  afterCheckout.includedSeconds === 120 * HOUR && afterCheckout.limits?.maxConcurrentSandboxes === 6, afterCheckout)
// List-by-email is consistent (search is not); the email is unique to this run.
const customerA = (await stripe<{ data: Array<{ id: string; metadata: Record<string, string> }> }>('GET', '/v1/customers', {
  email: `e2e+${orgA}@example.com`
})).data.find((customer) => customer.metadata.account_id === accountA)?.id ?? ''
const subsA = await stripe<{ data: Array<{ id: string; items: { data: Array<{ price: { id: string } }> } }> }>('GET', '/v1/subscriptions', { customer: customerA })
ids.checkoutCustomer = customerA
ids.checkoutSubscription = subsA.data[0]?.id ?? ''

// ---- 2. Opt in to overage --------------------------------------------------------------------
const optIn = await billing('POST', '/v1/billing/overage', orgA, { enabled: true })
const subA = await stripe<{ items: { data: Array<{ price: { id: string } }> } }>('GET', `/v1/subscriptions/${ids.checkoutSubscription}`)
check('overage opt-in adds the metered item ($25 default cap)', optIn.status === 200 && optIn.body.overage?.active === true &&
  optIn.body.overage?.spendCapCents === 2500 && subA.items.data.some((item) => item.price.id === catalog.STRIPE_PRICE_OVERAGE), optIn.body)

// ---- 3. Usage past included hours -> meter events --------------------------------------------
const meterStart = Math.floor(Date.now() / 1000 / 60) * 60 - 2 * 24 * HOUR
for (let i = 0; i < 5; i++) {
  await reportUsage(accountA, 24)
}
const crossing = await reportUsage(accountA, 4)
check('usage past 120 h: 4 h overage recorded, starts still allowed', crossing.overageSeconds === 4 * HOUR && crossing.canStartSandbox === true, crossing)
const warned = await entitlement(orgA)
check('100% included-hours warning', warned.usageWarningPercent === 100, warned.usageWarningPercent)

// ---- 4. Spend cap ----------------------------------------------------------------------------
await reportUsage(accountA, 20)
await reportUsage(accountA, 20)
const capped = await startCheck(accountA)
check('spend cap ($25 = 33.3 overage h) reached -> new starts blocked', capped.allow === false && capped.reason === 'overage_cap_reached', capped)
const spent = await entitlement(orgA)
check('metered spend stops at the cap', spent.overage?.spentCents <= 2500 && spent.overage?.spentCents >= 2490, spent.overage)

const meterEnd = Math.ceil(Date.now() / 1000 / 60) * 60 + 60
const summaries = await until(
  'meter event summaries',
  () => stripe<{ data: Array<{ aggregated_value: number }> }>('GET', `/v1/billing/meters/${catalog.meter}/event_summaries`, {
    customer: customerA, start_time: meterStart, end_time: meterEnd
  }),
  (s) => s.data.reduce((sum, row) => sum + row.aggregated_value, 0) >= Math.floor((2500 / 75) * HOUR),
  240_000
)
const meteredTotal = summaries.data.reduce((sum, row) => sum + row.aggregated_value, 0)
check('Stripe meter received exactly the capped overage seconds', meteredTotal === Math.floor((2500 / 75) * HOUR), { meteredTotal })

// ---- 5. Portal ------------------------------------------------------------------------------
// ---- 5a. Seats follow membership (auth pushes member counts) ------------------------------------
// Peak seats (design "Seat fairness"): adds charged now, removals only at renewal, re-add free.
const membershipToken = process.env.E2E_MEMBERSHIP_TOKEN
const pushMembers = async (accountId: string, members: number) => {
  const response = await fetch(`${BILLING_URL}/v1/internal/seats`, {
    method: 'POST',
    headers: { authorization: `Bearer ${membershipToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ accountId, members })
  })
  return (await response.json()) as Record<string, any>
}
const seatQuantity = async (subscription: string) =>
  (await stripe<{ items: { data: Array<{ quantity: number; price: { id: string } }> } }>('GET', `/v1/subscriptions/${subscription}`))
    .items.data.find((item) => item.price.id === catalog.STRIPE_PRICE_TEAM_MONTHLY)?.quantity
const invoicesOf = (subscription: string) =>
  stripe<{ data: Array<{ id: string; billing_reason: string; status: string; amount_due: number; lines: { data: Array<{ quantity: number }> } }> }>(
    'GET', '/v1/invoices', { subscription, limit: 10 })
if (membershipToken) {
  const added = await pushMembers(accountA, 3)
  const afterAdd = await invoicesOf(ids.checkoutSubscription)
  check('member added -> 3 seats, prorated invoice charged now', added.status === 'increased' && (await seatQuantity(ids.checkoutSubscription)) === 3 &&
    afterAdd.data[0]?.billing_reason === 'subscription_update' && afterAdd.data[0]?.status === 'paid' && afterAdd.data[0]?.amount_due > 0,
    { added, invoice: afterAdd.data[0] })
  const removed = await pushMembers(accountA, 2)
  const afterRemove = await entitlement(orgA)
  check('member removed mid-period -> deferred to renewal, still 3 paid seats + 180 h, no credit', removed.status === 'deferred' &&
    (await seatQuantity(ids.checkoutSubscription)) === 3 && afterRemove.seats === 3 && afterRemove.includedSeconds === 180 * HOUR,
    { removed, seats: afterRemove.seats })
  const readded = await pushMembers(accountA, 3)
  const afterReadd = await invoicesOf(ids.checkoutSubscription)
  check('re-add within the period is free (no new invoice)', readded.status === 'unchanged' && afterReadd.data.length === afterAdd.data.length &&
    afterReadd.data[0]?.id === afterAdd.data[0]?.id, { readded, invoices: afterReadd.data.length })
  check('pending invites do not change seats (same member count is a no-op)', (await pushMembers(accountA, 3)).status === 'unchanged')
}

const portal = await billing('POST', '/v1/billing/portal', orgA)
check('customer portal session (seats, monthly<->annual, cancel config)', /^https:\/\/billing\.stripe\.com\//.test(portal.body.url ?? ''), portal.body)

// ---- 6. Annual plan + overage (mixed intervals) -----------------------------------------------
const orgB = `e2e-${runId}-b`
const customerB = await stripe<{ id: string }>('POST', '/v1/customers', { email: `e2e+${orgB}@example.com`, metadata: { account_id: `org:${orgB}` } })
ids.annualCustomer = customerB.id
linkAccount(`org:${orgB}`, customerB.id)
await stripe('POST', '/v1/payment_methods/pm_card_visa/attach', { customer: customerB.id })
  .then((pm: any) => stripe('POST', `/v1/customers/${customerB.id}`, { invoice_settings: { default_payment_method: pm.id } }))
const annualSub = await stripe<{ id: string }>('POST', '/v1/subscriptions', {
  customer: customerB.id, items: [{ price: catalog.STRIPE_PRICE_TEAM_ANNUAL, quantity: 3 }], metadata: { account_id: `org:${orgB}` }
})
ids.annualSubscription = annualSub.id
const annualEnt = await until('annual active', () => entitlement(orgB), (e) => e.status === 'active')
check('annual Team: 3 seats, 180 h monthly allowance window', annualEnt.interval === 'year' && annualEnt.includedSeconds === 180 * HOUR &&
  annualEnt.usageWindow && annualEnt.usageWindow.end - annualEnt.usageWindow.start <= 31 * 24 * HOUR * 1000, annualEnt)
const annualOptIn = await billing('POST', '/v1/billing/overage', orgB, { enabled: true })
check('annual plan accepts the monthly metered overage item', annualOptIn.status === 200 && annualOptIn.body.overage?.active === true, annualOptIn)

// ---- 7. Test clock: renewal, then invoice.payment_failed --------------------------------------
const orgC = `e2e-${runId}-c`
// Start the clock one month before (now + 3 h): the first period then ends inside the Worker's
// real-time seat true-down window (6 h), so the removal below lands on the renewal invoice.
const startDate = new Date(Date.now() + 3 * HOUR * 1000)
startDate.setUTCMonth(startDate.getUTCMonth() - 1)
const start = Math.floor(startDate.getTime() / 1000)
const clock = await stripe<{ id: string }>('POST', '/v1/test_helpers/test_clocks', { frozen_time: start, name: `orca-e2e-${runId}` })
ids.testClock = clock.id
const customerC = await stripe<{ id: string }>('POST', '/v1/customers', { email: `e2e+${orgC}@example.com`, test_clock: clock.id, metadata: { account_id: `org:${orgC}` } })
ids.clockCustomer = customerC.id
linkAccount(`org:${orgC}`, customerC.id)
const visa = await stripe<{ id: string }>('POST', '/v1/payment_methods/pm_card_visa/attach', { customer: customerC.id })
await stripe('POST', `/v1/customers/${customerC.id}`, { invoice_settings: { default_payment_method: visa.id } })
const clockSub = await stripe<{ id: string }>('POST', '/v1/subscriptions', {
  customer: customerC.id, items: [{ price: catalog.STRIPE_PRICE_TEAM_MONTHLY, quantity: 2 }], metadata: { account_id: `org:${orgC}` }
})
ids.clockSubscription = clockSub.id
const before = await until('clock sub active', () => entitlement(orgC), (e) => e.status === 'active')
if (membershipToken) {
  const trueDown = await pushMembers(`org:${orgC}`, 1)
  const pending = await invoicesOf(clockSub.id)
  check('member removed inside the true-down window -> 1 seat for renewal, no proration', trueDown.status === 'reduced_at_renewal' &&
    (await seatQuantity(clockSub.id)) === 1 && pending.data.length === 1, { trueDown, invoices: pending.data.length })
}
await advanceClock(clock.id, before.period.end / 1000 + HOUR)
const renewed = await until('renewal synced', () => entitlement(orgC), (e) => e.period?.start === before.period.end, 120_000)
check('test-clock renewal rolls the period (invoice.paid -> new window)', renewed.period?.start === before.period.end && renewed.status === 'active', {
  before: before.period, after: renewed.period
})
if (membershipToken) {
  const cycle = (await invoicesOf(clockSub.id)).data.find((invoice) => invoice.billing_reason === 'subscription_cycle')
  check('renewal invoice bills the smaller team (1 seat), entitlement 1 seat', cycle?.status === 'paid' &&
    cycle.lines.data.every((line) => line.quantity <= 1) && renewed.seats === 1, { cycle: cycle?.id, seats: renewed.seats })
}
const failing = await stripe<{ id: string }>('POST', '/v1/payment_methods/pm_card_chargeCustomerFail/attach', { customer: customerC.id })
await stripe('POST', `/v1/customers/${customerC.id}`, { invoice_settings: { default_payment_method: failing.id } })
await advanceClock(clock.id, renewed.period.end / 1000 + HOUR)
const pastDue = await until('past_due synced', () => entitlement(orgC), (e) => e.status === 'past_due', 120_000)
check('invoice.payment_failed -> past_due -> starts blocked', pastDue.status === 'past_due' && pastDue.reason === 'payment_past_due', pastDue.status)
const graceSeconds = Number(process.env.E2E_GRACE_SECONDS ?? 4 * 24 * HOUR)
check('grace window recorded (suspend running after the grace)', pastDue.payment?.suspendRunning === false &&
  pastDue.payment?.graceEndsAt - pastDue.payment?.pastDueSince === graceSeconds * 1000, pastDue.payment)
{
  // Grace runs on the Worker's real clock (test clocks don't move it). A short grace
  // (BILLING_PLANS team.paymentGraceHours, local runs) is watched expiring; a long one (dev: 96 h)
  // is reached by backdating past_due_since in D1 past the grace.
  if (graceSeconds > 120) {
    if (!/^sub_[A-Za-z0-9]+$/.test(clockSub.id)) {
      throw new Error('unsafe id')
    }
    d1(`UPDATE subscriptions SET past_due_since = ${pastDue.payment.pastDueSince - (graceSeconds + 60) * 1000} WHERE stripe_subscription_id = '${clockSub.id}'`)
  }
  const suspended = await until('grace expiry', () => startCheck(`org:${orgC}`), (c) => c.suspendRunning === true, (Math.min(graceSeconds, 120) + 60) * 1000)
  check('grace expired -> suspendRunning, reason payment_grace_expired', suspended.suspendRunning === true && suspended.reason === 'payment_grace_expired', suspended)
  const listed = await billing('GET', '/v1/internal/suspensions', null).then((r) => r.body)
  check('/v1/internal/suspensions lists the account', listed.accounts?.some((a: any) => a.accountId === `org:${orgC}`), listed)
  // Pay the open invoice with a good card -> active -> resume allowed.
  const goodCard = await stripe<{ id: string }>('POST', '/v1/payment_methods/pm_card_visa/attach', { customer: customerC.id })
  await stripe('POST', `/v1/customers/${customerC.id}`, { invoice_settings: { default_payment_method: goodCard.id } })
  const live = await stripe<{ latest_invoice: string }>('GET', `/v1/subscriptions/${clockSub.id}`)
  await stripe('POST', `/v1/invoices/${live.latest_invoice}/pay`, { payment_method: goodCard.id })
  const resumed = await until('paid', () => startCheck(`org:${orgC}`), (c) => c.allow === true, 120_000)
  check('paid -> resume allowed, suspendRunning cleared', resumed.allow === true && resumed.suspendRunning === false, resumed)
}

// ---- 8. Cancel -------------------------------------------------------------------------------
await stripe('DELETE', `/v1/subscriptions/${ids.checkoutSubscription}`)
const canceled = await until('cancel synced', () => entitlement(orgA), (e) => e.status === 'canceled')
check('cancel -> subscription_inactive, starts blocked', canceled.status === 'canceled' && canceled.canStartSandbox === false, canceled.status)

// ---- 9. 3D Secure Checkout: challenge completed; 3DS-then-decline and insufficient funds -----
type Session = { id: string; status: string; payment_status: string; customer: string | null; subscription: string | null }
const sessionOf = (url: string) => stripe<Session>('GET', `/v1/checkout/sessions/${new URL(url).pathname.match(/cs_test_[A-Za-z0-9]+/)?.[0]}`)
const orgD = `e2e-${runId}-d`
const threeDsCheckout = await billing('POST', '/v1/billing/checkout', orgD, { plan: 'team', seats: 2, interval: 'month' })
const threeDs = await completeCheckout(threeDsCheckout.body.url, '4000002500003155', { threeDS: 'complete' })
const threeDsSession = await sessionOf(threeDsCheckout.body.url)
const threeDsEnt = await until('3DS subscription active', () => entitlement(orgD), (e) => e.status === 'active')
ids.threeDsSession = threeDsSession.id
ids.threeDsCustomer = threeDsSession.customer ?? ''
ids.threeDsSubscription = threeDsSession.subscription ?? ''
check('3DS card (3155): challenge completed in Checkout -> Team active', threeDs.success && threeDs.challenged && threeDsSession.status === 'complete' &&
  threeDsSession.payment_status === 'paid' && threeDsEnt.status === 'active' && threeDsEnt.seats === 2, { threeDs, status: threeDsEnt.status })
if (ids.threeDsSubscription) {
  const sub = await stripe<{ latest_invoice: { payments?: { data: Array<{ payment: { payment_intent?: string } }> } } }>('GET',
    `/v1/subscriptions/${ids.threeDsSubscription}`, { expand: ['latest_invoice.payments'] })
  ids.threeDsPaymentIntent = sub.latest_invoice.payments?.data[0]?.payment.payment_intent ?? ''
  await stripe('DELETE', `/v1/subscriptions/${ids.threeDsSubscription}`)
}

for (const [name, card, threeDS] of [
  ['3DS then decline (1629)', '4000008400001629', 'complete'],
  ['insufficient funds (9995)', '4000000000009995', undefined]
] as const) {
  const org = `e2e-${runId}-${card.slice(-4)}`
  const declined = await billing('POST', '/v1/billing/checkout', org, { plan: 'team', seats: 2, interval: 'month' })
  const outcome = await completeCheckout(declined.body.url, card, { threeDS, expectSuccess: false })
  await sleep(5000)
  const session = await sessionOf(declined.body.url)
  const ent = await entitlement(org)
  ids[`declined${card.slice(-4)}Session`] = session.id
  check(`${name}: Checkout shows the decline, no subscription created`, !outcome.success && (threeDS ? outcome.challenged : true) &&
    session.status === 'open' && !session.subscription && ent.status !== 'active' && ent.canStartSandbox === false,
    { outcome, session: session.status, subscription: session.subscription, status: ent.status })
  await stripe('POST', `/v1/checkout/sessions/${session.id}/expire`).catch(() => undefined)
}

// ---- 10. Cleanup: remaining test subscriptions and the test clock (deletes its customer) -------
await stripe('DELETE', `/v1/subscriptions/${ids.annualSubscription}`).catch((error) => console.log(`  cleanup: ${error}`))
await stripe('DELETE', `/v1/test_helpers/test_clocks/${ids.testClock}`).catch((error) => console.log(`  cleanup: ${error}`))

console.log(JSON.stringify({ runId, ids }, null, 2))
const failed = results.filter((r) => !r.ok)
console.log(`${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
