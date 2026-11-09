// Stripe TEST-mode helpers: key from ORCA_EVAL_STRIPE_KEY or the Stripe CLI `orca` profile (never
// printed), refusing anything that is not a test key or returns a live-mode object.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { secrets } from './env'

let cached: string | null = null
export function stripeKey(): string {
  if (cached) {
    return cached
  }
  let key = secrets.stripeKey()
  if (!key) {
    const toml = readFileSync(`${homedir()}/.config/stripe/config.toml`, 'utf8')
    const section = toml.split(/^\[/m).find((s) => s.startsWith('orca]'))
    key = /test_mode_api_key\s*=\s*['"]([^'"]+)['"]/.exec(section ?? '')?.[1] ?? null
  }
  if (!key || !/^(sk|rk)_test_/.test(key)) {
    throw new Error('Refusing: a Stripe TEST key is required')
  }
  cached = key
  return key
}

function encode(params: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(params).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}[${k}]` : k
    if (v === undefined) {
      return []
    }
    if (v !== null && typeof v === 'object') {
      return encode(v as Record<string, unknown>, key)
    }
    return [`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`]
  })
}

export async function stripe<T = any>(method: 'GET' | 'POST' | 'DELETE', path: string, params?: Record<string, unknown>): Promise<T> {
  const url = new URL(`https://api.stripe.com${path}`)
  const body = params ? encode(params).join('&') : undefined
  if (method !== 'POST' && body) {
    url.search = body
  }
  const response = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${stripeKey()}`, 'content-type': 'application/x-www-form-urlencoded', 'stripe-version': '2025-09-30.clover' },
    body: method === 'POST' ? body : undefined
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

export type CheckoutCard = { number: string; label: string; threeDS?: boolean }
export const CARDS = {
  visa: { number: '4242424242424242', label: 'Visa 4242' },
  threeDS: { number: '4000002760003184', label: '3DS2 required 3184', threeDS: true }
} satisfies Record<string, CheckoutCard>

/** Completes hosted Checkout in headless Chrome; returns ms and a screenshot path. */
export async function completeCheckout(url: string, card: CheckoutCard, shotPath: string): Promise<{ ms: number; shot: string; landed: string }> {
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({ headless: true, channel: 'chrome' })
  const started = performance.now()
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    // Newer Checkout pages show the card form behind a "Card" accordion.
    const cardTab = page.locator('[data-testid="card-accordion-item-button"]')
    if (await cardTab.count().catch(() => 0)) {
      await cardTab.click().catch(() => {})
    }
    await page.locator('#cardNumber').waitFor({ timeout: 60_000 })
    await page.fill('#cardNumber', card.number)
    await page.fill('#cardExpiry', '12/34')
    await page.fill('#cardCvc', '123')
    if (await page.locator('#billingName').count()) {
      await page.fill('#billingName', 'Orca Eval')
    }
    if (await page.locator('#billingPostalCode').count()) {
      await page.fill('#billingPostalCode', '94107')
    }
    const link = page.locator('#enableStripePass')
    if ((await link.count()) && (await link.isChecked())) {
      await link.uncheck({ force: true })
    }
    await page.screenshot({ path: shotPath.replace('.png', '-form.png') })
    await page.locator('[data-testid="hosted-payment-submit-button"], .SubmitButton').first().click()
    if (card.threeDS) {
      // Stripe's test 3DS2 challenge: nested iframes with a "Complete" button.
      const deadline = Date.now() + 60_000
      let done = false
      while (!done && Date.now() < deadline) {
        for (const frame of page.frames()) {
          const button = frame.locator('#test-source-authorize-3ds, button:has-text("Complete")')
          if (await button.count().catch(() => 0)) {
            await page.screenshot({ path: shotPath.replace('.png', '-3ds.png') })
            await button.first().click().catch(() => {})
            done = true
            break
          }
        }
        if (!done) {
          await page.waitForTimeout(1000)
        }
      }
      if (!done) {
        throw new Error('3DS challenge not found')
      }
    }
    await page.waitForURL((current) => !current.hostname.endsWith('checkout.stripe.com'), { timeout: 90_000 })
    await page.screenshot({ path: shotPath })
    return { ms: Math.round(performance.now() - started), shot: shotPath, landed: page.url().replace(/session_id=[^&]+/, 'session_id=…') }
  } finally {
    await browser.close()
  }
}
