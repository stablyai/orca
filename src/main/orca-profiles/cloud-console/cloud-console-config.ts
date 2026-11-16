// Where the web console lives and how the desktop asks auth for a console ticket. One module so
// the contract is easy to adjust (orca-cloud apps/auth/src/http/console-ticket-route.ts).
import { cleanCloudServiceOrigin } from '../../../shared/network/cloud-service-url'
import type { OrcaCloudAuthConfig } from '../cloud-auth/profile-cloud-auth-config'

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

/** Without a ticket: the console's front door, where the browser asks the person to sign in. */
export function cloudConsoleFallbackUrl(origin: string): string {
  return new URL('/console', origin).toString()
}
