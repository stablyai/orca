// URLs of the cloud setup pages on Orca Cloud auth (auth.onorca.dev/cloud/setup/...).
import type { Env } from './env'

function pagesOrigin(env: Env): string {
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
