// Opens a web console page in the system browser (never an in-app view) through a single-use ticket
// URL from auth, so the browser lands signed in; when that fails for any reason the console opens
// without one and the browser asks the person to sign in. The ticket is never logged or kept.
import { app, shell } from 'electron'
import { cleanCloudServiceOrigin } from '../../../shared/cloud-service-url'
import {
  ORCA_CLOUD_CONSOLE_BILLING_HINT_CAPABILITY,
  type OrcaCloudConsoleBillingHint,
  type OrcaCloudConsoleOpenResult,
  type OrcaCloudConsoleSection
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

/**
 * The ticket request body. The billing hint goes only to an auth that advertises it: an older
 * ticket route takes a strict body and would refuse the extra fields, losing the signed-in landing.
 */
export function cloudConsoleTicketBody(
  session: { capabilities?: { flags: Record<string, boolean> } },
  args: {
    section: OrcaCloudConsoleSection
    orgId: string | null
    billingHint?: OrcaCloudConsoleBillingHint | null
  }
): Record<string, string> {
  const hint =
    args.section === 'billing' &&
    args.billingHint &&
    session.capabilities?.flags[ORCA_CLOUD_CONSOLE_BILLING_HINT_CAPABILITY] === true
      ? args.billingHint
      : null
  return {
    page: args.section,
    ...(args.orgId ? { orgId: args.orgId } : {}),
    ...(hint ? { plan: hint.plan, interval: hint.interval } : {})
  }
}

/** Asks auth for a single-use console ticket; answers its `url` unchecked (see acceptedTicketUrl). */
export async function requestCloudConsoleTicket(
  config: Pick<OrcaCloudAuthConfig, 'apiBaseUrl'>,
  session: Pick<OrcaCloudSession, 'accessToken'> & Partial<Pick<OrcaCloudSession, 'capabilities'>>,
  args: {
    section: OrcaCloudConsoleSection
    orgId: string | null
    billingHint?: OrcaCloudConsoleBillingHint | null
  },
  fetchImpl: typeof fetch = fetch
): Promise<unknown> {
  const post = (body: Record<string, string>): Promise<Response> =>
    fetchImpl(cloudConsoleTicketUrl(config), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.accessToken}`
      },
      body: JSON.stringify(body),
      // Never follow a redirect with the access token attached.
      redirect: 'error',
      signal: AbortSignal.timeout(CLOUD_CONSOLE_TICKET_TIMEOUT_MS)
    })
  const body = cloudConsoleTicketBody(session, args)
  let response = await post(body)
  if (response.status === 400 && 'plan' in body) {
    // An auth that refuses the hint (rolled back, or advertising it too early): the signed-in
    // landing matters more than the preselect, so ask once more without it.
    response = await post(cloudConsoleTicketBody({}, args))
  }
  if (!response.ok) {
    throw new OrcaCloudRequestError(response.status, await extractErrorCode(response))
  }
  const answer: unknown = await response.json().catch(() => null)
  return typeof answer === 'object' && answer !== null && 'url' in answer ? answer.url : null
}

type MintedTicket = {
  /** Auth's answer, unchecked (see acceptedTicketUrl); null when no ticket could be minted. */
  url: unknown
  /** The console origin auth advertises in the session's capabilities, when it does. */
  consoleOrigin: string | null
  /** A signed-in desktop asked for a ticket (so a missing one is a failure worth saying). */
  attempted: boolean
}

/** The advertised console origin, re-checked: https only, an origin and nothing more. */
export function advertisedConsoleOrigin(value: unknown): string | null {
  return typeof value === 'string' ? cleanCloudServiceOrigin(value, false) : null
}

async function mintTicket(
  config: OrcaCloudAuthConfig,
  userDataPath: string,
  section: OrcaCloudConsoleSection,
  billingHint: OrcaCloudConsoleBillingHint | null
): Promise<MintedTicket> {
  const none: MintedTicket = { url: null, consoleOrigin: null, attempted: false }
  if (isOrcaCloudDevAuthEnabled()) {
    return none
  }
  const active = ensureActiveOrcaProfile(userDataPath)
  if (!active.profile.cloud) {
    return none
  }
  const orgId = active.profile.cloud.activeOrgId ?? null
  const seen: { consoleOrigin: string | null } = { consoleOrigin: null }
  const result = await runOrgMemberCall(config, active, userDataPath, (session) => {
    seen.consoleOrigin = advertisedConsoleOrigin(session.capabilities?.consoleOrigin)
    return requestCloudConsoleTicket(config, session, { section, orgId, billingHint })
  }).catch(() => null)
  return {
    url: result?.status === 'ok' ? result.value : null,
    consoleOrigin: seen.consoleOrigin,
    attempted: true
  }
}

export async function openOrcaCloudConsole(
  userDataPath: string,
  section: OrcaCloudConsoleSection,
  options: {
    billingHint?: OrcaCloudConsoleBillingHint | null
    openExternal?: (url: string) => Promise<void>
  } = {}
): Promise<OrcaCloudConsoleOpenResult> {
  const openExternal = options.openExternal ?? ((url: string) => shell.openExternal(url))
  const configState = getOrcaCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  const { config } = configState
  const configured = cloudConsoleOrigin(config, process.env, !app.isPackaged)
  const minted = await mintTicket(config, userDataPath, section, options.billingHint ?? null)
  // Auth's own advertised console host is trusted alongside the configured one, so a console that
  // moved hosts (or a stale ORCA_CLOUD_CONSOLE_URL) still opens signed in. Exact origins only.
  const allowed = [configured, new URL(config.apiBaseUrl).origin, minted.consoleOrigin].filter(
    (entry): entry is string => entry !== null
  )
  const ticketUrl = acceptedTicketUrl(minted.url, allowed)
  try {
    await openExternal(ticketUrl ?? cloudConsoleFallbackUrl(minted.consoleOrigin ?? configured))
    return {
      status: 'opened',
      signedIn: ticketUrl !== null,
      ...(minted.attempted && ticketUrl === null
        ? { ticketError: minted.url === null ? 'failed' : 'rejected' }
        : {})
    }
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}
