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
// Flows: Checkout (2 seats, test card, headless browser) -> overage opt-in -> usage past the
// included hours -> meter events in Stripe -> spend cap blocks starts -> annual plan + overage ->
// test-clock renewal -> invoice.payment_failed -> cancel. Prints PASS/FAIL per check and the ids.
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
  execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', ...d1Args, '--command',
      `INSERT INTO billing_accounts (account_id, stripe_customer_id, created_at, updated_at) VALUES ('${accountId}', '${customer}', ${now}, ${now})`],
    { stdio: 'ignore', env: { ...process.env, CI: '1' } }
  )
}

async function completeCheckout(url: string) {
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.locator('#cardNumber').waitFor({ timeout: 60_000 })
    await page.fill('#cardNumber', '4242424242424242')
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
    try {
      await page.waitForURL((current) => current.searchParams.get('checkout') === 'success', { timeout: 90_000 })
    } catch (error) {
      if (process.env.E2E_SCREENSHOT_DIR) {
        await page.screenshot({ path: `${process.env.E2E_SCREENSHOT_DIR}/checkout-failure.png`, fullPage: true })
      }
      throw error
    }
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
const start = Math.floor(Date.now() / 1000)
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
await advanceClock(clock.id, before.period.end / 1000 + HOUR)
const renewed = await until('renewal synced', () => entitlement(orgC), (e) => e.period?.start === before.period.end, 120_000)
check('test-clock renewal rolls the period (invoice.paid -> new window)', renewed.period?.start === before.period.end && renewed.status === 'active', {
  before: before.period, after: renewed.period
})
const failing = await stripe<{ id: string }>('POST', '/v1/payment_methods/pm_card_chargeCustomerFail/attach', { customer: customerC.id })
await stripe('POST', `/v1/customers/${customerC.id}`, { invoice_settings: { default_payment_method: failing.id } })
await advanceClock(clock.id, renewed.period.end / 1000 + HOUR)
const pastDue = await until('past_due synced', () => entitlement(orgC), (e) => e.status === 'past_due', 120_000)
check('invoice.payment_failed -> past_due -> starts blocked', pastDue.status === 'past_due' && pastDue.reason === 'payment_past_due', pastDue.status)

// ---- 8. Cancel -------------------------------------------------------------------------------
await stripe('DELETE', `/v1/subscriptions/${ids.checkoutSubscription}`)
const canceled = await until('cancel synced', () => entitlement(orgA), (e) => e.status === 'canceled')
check('cancel -> subscription_inactive, starts blocked', canceled.status === 'canceled' && canceled.canStartSandbox === false, canceled.status)

console.log(JSON.stringify({ runId, ids }, null, 2))
const failed = results.filter((r) => !r.ok)
console.log(`${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
