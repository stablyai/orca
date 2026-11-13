// URLs of the cloud setup pages on Orca Cloud auth (auth.onorca.dev/cloud/setup/...).
import type { Env } from './env'

/** Thrown when CLOUD_SETUP_PAGES_URL is unset in prod; the index answers 503 billing_misconfigured. */
export class SetupPagesConfigError extends Error {
  constructor() {
    super('cloud_setup_pages_url_missing')
    this.name = 'SetupPagesConfigError'
  }
}

function pagesOrigin(env: Env): string {
  if (!env.CLOUD_SETUP_PAGES_URL && env.BILLING_ENV === 'prod') {
    // Prod must name its pages origin; the fallback below is only a dev/staging convenience.
    throw new SetupPagesConfigError()
  }
  return (env.CLOUD_SETUP_PAGES_URL ?? 'https://auth.onorca.dev').replace(/\/$/, '')
}

export function setupPageUrl(env: Env, path: string, params: Record<string, string>): string {
  const url = new URL(`${pagesOrigin(env)}/cloud/setup${path}`)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}

/** Checkout return URLs for a setup session: success continues the chain, cancel goes back to T3. */
export function setupCheckoutReturnUrls(env: Env, id: string): { success: string; cancel: string } {
  return {
    success: setupPageUrl(env, '/next', { session: id, from: 'checkout', checkout: 'success' }),
    cancel: setupPageUrl(env, '/plan', { session: id, checkout: 'canceled' })
  }
}
