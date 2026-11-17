// Where the web console lives and how the desktop asks auth for a console ticket. One module so
// the contract is easy to adjust (orca-cloud apps/auth/src/http/console-ticket-route.ts).
import { cleanCloudServiceOrigin } from '../../../shared/network/cloud-service-url'
import type { OrcaCloudAuthConfig } from '../cloud-auth/profile-cloud-auth-config'
import type {
  OrcaCloudConsoleBillingHint,
  OrcaCloudConsoleSection
} from '../../../shared/orca-cloud-console'

/**
 * Mints a single-use console ticket for the signed-in desktop session (Bearer access token).
 * Body (strict, at most 256 bytes): `{ page?, orgId? }`. Answer: `{ url, expiresAt }`; the desktop
 * opens `url` as-is.
 */
export const CLOUD_CONSOLE_TICKET_PATH = '/v1/desktop/console/ticket'
/** A click should open the browser promptly; past this the console opens without a ticket. */
export const CLOUD_CONSOLE_TICKET_TIMEOUT_MS = 8_000

/**
 * The console's origin: ORCA_CLOUD_CONSOLE_URL when set (staging, local dev), else the auth
 * service's own origin, which serves the console pages.
 */
export function cloudConsoleOrigin(
  config: Pick<OrcaCloudAuthConfig, 'apiBaseUrl'>,
  env: NodeJS.ProcessEnv,
  allowLoopbackHttp: boolean
): string {
  return (
    cleanCloudServiceOrigin(env.ORCA_CLOUD_CONSOLE_URL, allowLoopbackHttp) ??
    new URL(config.apiBaseUrl).origin
  )
}

export function cloudConsoleTicketUrl(config: Pick<OrcaCloudAuthConfig, 'apiBaseUrl'>): string {
  return new URL(CLOUD_CONSOLE_TICKET_PATH, `${config.apiBaseUrl}/`).toString()
}

/**
 * Without a ticket: the page itself, where a signed-out browser signs in and comes back to the same
 * path (the console keeps it, and the billing page's plan hint, through its sign-in). The team
 * list (`/console`) when there is no team or the page isn't a team page.
 */
export function cloudConsoleFallbackUrl(
  origin: string,
  target: {
    section: OrcaCloudConsoleSection
    orgId: string | null
    billingHint?: OrcaCloudConsoleBillingHint | null
  } = { section: 'home', orgId: null }
): string {
  if (!target.orgId || target.section === 'home') {
    return new URL('/console', origin).toString()
  }
  // The console's own org path segment (its teamHref): encoded, with ':' kept as is.
  const org = encodeURIComponent(target.orgId).replaceAll('%3A', ':')
  const url = new URL(`/console/orgs/${org}/${target.section}`, origin)
  if (target.section === 'billing' && target.billingHint) {
    url.searchParams.set('plan', target.billingHint.plan)
    url.searchParams.set('interval', target.billingHint.interval)
  }
  return url.toString()
}
