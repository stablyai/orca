// Opens the web console in the system browser through a single-use ticket URL from auth, so the
// browser lands signed in; on any failure the console opens without one and asks for a sign-in.
// The ticket is never logged or kept.
import { cleanCloudServiceOrigin } from '../../../shared/network/cloud-service-url'
import type {
  OrcaCloudConsoleOpenResult,
  OrcaCloudConsoleSection
} from '../../../shared/orca-cloud-console'
import {
  getOrcaCloudAuthConfig,
  isOrcaCloudDevAuthEnabled,
  isPackagedOrcaBuild,
  type OrcaCloudAuthConfig
} from '../cloud-auth/profile-cloud-auth-config'
import { OrcaCloudRequestError } from '../cloud-auth/profile-cloud-client'
import type { OrcaCloudSession } from '../cloud-session/profile-cloud-session-store'
import { runWithFreshOrcaCloudSession } from '../cloud-session/profile-cloud-session-refresh'
import { ensureActiveOrcaProfile, type ActiveOrcaProfileState } from '../profile-index-store'

// Body `{ page?, orgId? }`, answer `{ url, expiresAt }` (orca-cloud apps/auth console-ticket-route.ts).
export const CLOUD_CONSOLE_TICKET_PATH = '/v1/desktop/console/ticket'
const CLOUD_CONSOLE_TICKET_TIMEOUT_MS = 8_000

/** ORCA_CLOUD_CONSOLE_URL when set (staging, local dev), else the auth origin, which redirects. */
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

/** Auth's URL as-is, or null unless it is plain http(s) on an allowed origin. */
export function acceptedTicketUrl(
  value: unknown,
  allowedOrigins: readonly string[]
): string | null {
  if (typeof value !== 'string') {
    return null
  }
  try {
    const url = new URL(value)
    const web = url.protocol === 'https:' || url.protocol === 'http:'
    return web && !url.username && !url.password && allowedOrigins.includes(url.origin)
      ? value
      : null
  } catch {
    return null
  }
}

async function requestCloudConsoleTicket(
  config: Pick<OrcaCloudAuthConfig, 'apiBaseUrl'>,
  session: Pick<OrcaCloudSession, 'accessToken'>,
  body: { page: OrcaCloudConsoleSection; orgId?: string },
  fetchImpl: typeof fetch
): Promise<unknown> {
  const response = await fetchImpl(new URL(CLOUD_CONSOLE_TICKET_PATH, `${config.apiBaseUrl}/`), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.accessToken}` },
    body: JSON.stringify(body),
    // Never follow a redirect with the access token attached.
    redirect: 'error',
    signal: AbortSignal.timeout(CLOUD_CONSOLE_TICKET_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new OrcaCloudRequestError(response.status)
  }
  const answer: unknown = await response.json().catch(() => null)
  return typeof answer === 'object' && answer !== null && 'url' in answer ? answer.url : null
}

type MintedTicket = { url: unknown; consoleOrigin: string | null; attempted: boolean }

async function mintTicket(
  config: OrcaCloudAuthConfig,
  active: ActiveOrcaProfileState,
  userDataPath: string,
  section: OrcaCloudConsoleSection,
  fetchImpl: typeof fetch
): Promise<MintedTicket> {
  if (isOrcaCloudDevAuthEnabled() || !active.profile.cloud) {
    return { url: null, consoleOrigin: null, attempted: false }
  }
  const orgId = active.profile.cloud.activeOrgId
  let consoleOrigin: string | null = null
  const result = await runWithFreshOrcaCloudSession(config, active, userDataPath, (session) => {
    consoleOrigin = cleanCloudServiceOrigin(session.capabilities.consoleOrigin, false)
    return requestCloudConsoleTicket(
      config,
      session,
      { page: section, ...(orgId ? { orgId } : {}) },
      fetchImpl
    )
  }).catch(() => null)
  return { url: result?.status === 'ok' ? result.value : null, consoleOrigin, attempted: true }
}

export async function openOrcaCloudConsole(
  userDataPath: string,
  section: OrcaCloudConsoleSection,
  openBrowser: (url: string) => Promise<void>,
  fetchImpl: typeof fetch = fetch
): Promise<OrcaCloudConsoleOpenResult> {
  const configState = getOrcaCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  const { config } = configState
  const configured = cloudConsoleOrigin(config, process.env, !isPackagedOrcaBuild())
  // One profile index read per click, like the other account actions.
  const active = ensureActiveOrcaProfile(userDataPath)
  const minted = await mintTicket(config, active, userDataPath, section, fetchImpl)
  // Auth's advertised console host is trusted beside the configured one, exact origins only.
  const allowed = [configured, new URL(config.apiBaseUrl).origin]
  if (minted.consoleOrigin) {
    allowed.push(minted.consoleOrigin)
  }
  const ticketUrl = acceptedTicketUrl(minted.url, allowed)
  try {
    await openBrowser(
      ticketUrl ?? new URL('/console', minted.consoleOrigin ?? configured).toString()
    )
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
  return {
    status: 'opened',
    signedIn: ticketUrl !== null,
    ...(minted.attempted && ticketUrl === null
      ? { ticketError: minted.url === null ? 'failed' : 'rejected' }
      : {})
  }
}
