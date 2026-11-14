// Opens a web console page in the system browser (never an in-app view). It first asks auth for a
// single-use login code so the browser lands signed in; when that fails for any reason the page
// opens without one and the browser asks the person to sign in. The code is never logged or kept.
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
  CLOUD_CONSOLE_CODE_FIELD,
  CLOUD_CONSOLE_CODE_TIMEOUT_MS,
  cloudConsoleCodeUrl,
  cloudConsoleOrigin,
  cloudConsolePageUrl
} from './cloud-console-config'

/** Auth's answer to the code request; anything but a non-empty string is no code. */
export async function requestCloudConsoleCode(
  config: Pick<OrcaCloudAuthConfig, 'apiBaseUrl'>,
  session: Pick<OrcaCloudSession, 'accessToken'>,
  args: { section: OrcaCloudConsoleSection; orgId: string | null },
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  const response = await fetchImpl(cloudConsoleCodeUrl(config), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${session.accessToken}`
    },
    body: JSON.stringify({ page: args.section, ...(args.orgId ? { orgId: args.orgId } : {}) }),
    // Never follow a redirect with the access token attached.
    redirect: 'error',
    signal: AbortSignal.timeout(CLOUD_CONSOLE_CODE_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new OrcaCloudRequestError(response.status, await extractErrorCode(response))
  }
  const body: unknown = await response.json().catch(() => null)
  const code =
    typeof body === 'object' && body !== null && CLOUD_CONSOLE_CODE_FIELD in body
      ? body[CLOUD_CONSOLE_CODE_FIELD]
      : undefined
  return typeof code === 'string' && code.trim() ? code.trim() : null
}

async function mintCode(
  config: OrcaCloudAuthConfig,
  userDataPath: string,
  section: OrcaCloudConsoleSection
): Promise<string | null> {
  if (isOrcaCloudDevAuthEnabled()) {
    return null
  }
  const active = ensureActiveOrcaProfile(userDataPath)
  if (!active.profile.cloud) {
    return null
  }
  const orgId = active.profile.cloud.activeOrgId ?? null
  const result = await runOrgMemberCall(config, active, userDataPath, (session) =>
    requestCloudConsoleCode(config, session, { section, orgId })
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
  const code = await mintCode(config, userDataPath, section).catch(() => null)
  try {
    await openExternal(cloudConsolePageUrl(origin, section, code))
    return { status: 'opened', signedIn: code !== null }
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}
