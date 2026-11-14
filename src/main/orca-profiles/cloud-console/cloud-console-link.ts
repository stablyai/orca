// Opens a web console page in the system browser (never an in-app view) through a single-use ticket
// URL from auth, so the browser lands signed in; when that fails for any reason the console opens
// without one and the browser asks the person to sign in. The ticket is never logged or kept.
import { app, shell } from 'electron'
import type {
  OrcaCloudConsoleOpenResult,
  OrcaCloudConsoleSection
} from '../../../shared/orca-cloud-console'
import {
  getOrcaCloudAuthConfig,
  isOrcaCloudDevAuthEnabled,
  type OrcaCloudAuthConfig
} from '../cloud-auth/profile-cloud-auth-config'
import { OrcaCloudRequestError } from '../cloud-auth/profile-cloud-client'
import type { OrcaCloudSession } from '../cloud-session/profile-cloud-session-store'
import { extractErrorCode } from '../cloud-org/profile-cloud-org-members-client'
import { runOrgMemberCall } from '../cloud-org/profile-cloud-org-members-service'
import { ensureActiveOrcaProfile } from '../profile-index-store'
import {
  CLOUD_CONSOLE_TICKET_TIMEOUT_MS,
  cloudConsoleFallbackUrl,
  cloudConsoleOrigin,
  cloudConsoleTicketUrl
} from './cloud-console-config'

/**
 * The ticket URL from auth, opened as-is; null for anything that isn't an http(s) URL on the
 * console's or auth's own origin, so a bad answer can never send the browser elsewhere.
 */
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

/** Asks auth for a single-use console ticket; answers its `url` unchecked (see acceptedTicketUrl). */
export async function requestCloudConsoleTicket(
  config: Pick<OrcaCloudAuthConfig, 'apiBaseUrl'>,
  session: Pick<OrcaCloudSession, 'accessToken'>,
  args: { section: OrcaCloudConsoleSection; orgId: string | null },
  fetchImpl: typeof fetch = fetch
): Promise<unknown> {
  const response = await fetchImpl(cloudConsoleTicketUrl(config), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${session.accessToken}`
    },
    body: JSON.stringify({ page: args.section, ...(args.orgId ? { orgId: args.orgId } : {}) }),
    // Never follow a redirect with the access token attached.
    redirect: 'error',
    signal: AbortSignal.timeout(CLOUD_CONSOLE_TICKET_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new OrcaCloudRequestError(response.status, await extractErrorCode(response))
  }
  const body: unknown = await response.json().catch(() => null)
  return typeof body === 'object' && body !== null && 'url' in body ? body.url : null
}

async function mintTicketUrl(
  config: OrcaCloudAuthConfig,
  userDataPath: string,
  section: OrcaCloudConsoleSection
): Promise<unknown> {
  if (isOrcaCloudDevAuthEnabled()) {
    return null
  }
  const active = ensureActiveOrcaProfile(userDataPath)
  if (!active.profile.cloud) {
    return null
  }
  const orgId = active.profile.cloud.activeOrgId ?? null
  const result = await runOrgMemberCall(config, active, userDataPath, (session) =>
    requestCloudConsoleTicket(config, session, { section, orgId })
  )
  return result.status === 'ok' ? result.value : null
}

export async function openOrcaCloudConsole(
  userDataPath: string,
  section: OrcaCloudConsoleSection,
  openExternal: (url: string) => Promise<void> = (url) => shell.openExternal(url)
): Promise<OrcaCloudConsoleOpenResult> {
  const configState = getOrcaCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  const { config } = configState
  const origin = cloudConsoleOrigin(config, process.env, !app.isPackaged)
  const ticketUrl = acceptedTicketUrl(
    await mintTicketUrl(config, userDataPath, section).catch(() => null),
    [origin, new URL(config.apiBaseUrl).origin]
  )
  try {
    await openExternal(ticketUrl ?? cloudConsoleFallbackUrl(origin))
    return { status: 'opened', signedIn: ticketUrl !== null }
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}
