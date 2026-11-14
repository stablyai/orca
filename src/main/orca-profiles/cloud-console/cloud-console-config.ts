// Where the web console lives and how the desktop asks auth for a console login code. One module so
// the contract is easy to adjust while the console ships (orca-cloud apps/auth, /console pages).
import { cleanCloudServiceOrigin } from '../../../shared/cloud-service-url'
import type { OrcaCloudConsoleSection } from '../../../shared/orca-cloud-console'
import type { OrcaCloudAuthConfig } from '../cloud-auth/profile-cloud-auth-config'

/**
 * Mints a single-use console login code for the signed-in desktop session (Bearer access token).
 * Request body: `{ page: <section>, orgId?: <active team> }`. Answer: `{ code: string }`.
 */
export const CLOUD_CONSOLE_CODE_PATH = '/v1/desktop/console/ticket'
/** The answer's field holding the code, and the query parameter the console page reads it from. */
export const CLOUD_CONSOLE_CODE_FIELD = 'code'
export const CLOUD_CONSOLE_CODE_PARAM = 'code'
/** A click should open the browser promptly; past this the page opens without a code. */
export const CLOUD_CONSOLE_CODE_TIMEOUT_MS = 8_000

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

export function cloudConsoleCodeUrl(config: Pick<OrcaCloudAuthConfig, 'apiBaseUrl'>): string {
  return new URL(CLOUD_CONSOLE_CODE_PATH, `${config.apiBaseUrl}/`).toString()
}

/** `<origin>/console/<section>`, with `?code=` only when there is one. */
export function cloudConsolePageUrl(
  origin: string,
  section: OrcaCloudConsoleSection,
  code: string | null
): string {
  const url = new URL(`/console/${section}`, origin)
  if (code) {
    url.searchParams.set(CLOUD_CONSOLE_CODE_PARAM, code)
  }
  return url.toString()
}
