import type { OrcaAccountMfa, OrcaAccountMfaResult } from '../../../shared/orca-account-mfa'
import type { OrcaCloudAuthConfig } from '../cloud-auth/profile-cloud-auth-config'
import {
  getOrcaCloudAuthConfig,
  isOrcaCloudDevAuthEnabled
} from '../cloud-auth/profile-cloud-auth-config'
import { OrcaCloudRequestError } from '../cloud-auth/profile-cloud-client'
import type { OrcaCloudSession } from '../cloud-session/profile-cloud-session-store'
import { extractErrorCode, requestInit } from '../cloud-org/profile-cloud-org-members-client'
import { runOrgMemberCall } from '../cloud-org/profile-cloud-org-members-service'
import { ensureActiveOrcaProfile } from '../profile-index-store'

/**
 * The renderer opens `setupUrl` in the browser, so it must be a page on Orca Cloud's own origin:
 * a compromised or misconfigured answer cannot send the person to another site to "set up MFA".
 */
export function normalizeAccountMfa(value: unknown, apiBaseUrl: string): OrcaAccountMfa {
  const record: Record<string, unknown> =
    typeof value === 'object' && value !== null ? { ...value } : {}
  const mfa = record.mfa === 'on' || record.mfa === 'off' ? record.mfa : null
  let setupUrl: URL | null = null
  try {
    setupUrl = typeof record.setupUrl === 'string' ? new URL(record.setupUrl) : null
  } catch {
    setupUrl = null
  }
  if (
    !mfa ||
    !setupUrl ||
    setupUrl.origin !== new URL(apiBaseUrl).origin ||
    setupUrl.username ||
    setupUrl.password
  ) {
    throw new Error('invalid_orca_account_mfa')
  }
  return { mfa, setupUrl: setupUrl.toString() }
}

async function fetchAccountMfa(
  config: OrcaCloudAuthConfig,
  session: OrcaCloudSession
): Promise<OrcaAccountMfa> {
  const response = await fetch(
    `${config.apiBaseUrl}/v1/desktop/auth/mfa`,
    requestInit('GET', session.accessToken)
  )
  if (!response.ok) {
    throw new OrcaCloudRequestError(response.status, await extractErrorCode(response))
  }
  const body: unknown = await response.json()
  return normalizeAccountMfa(body, config.apiBaseUrl)
}

export async function getOrcaProfileAccountMfa(
  userDataPath: string
): Promise<OrcaAccountMfaResult> {
  const active = ensureActiveOrcaProfile(userDataPath)
  // Local dev auth has no server and no factor to enrol.
  if (isOrcaCloudDevAuthEnabled()) {
    return { status: 'unsupported' }
  }
  const configState = getOrcaCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  const result = await runOrgMemberCall(configState.config, active, userDataPath, (session) =>
    fetchAccountMfa(configState.config, session)
  )
  switch (result.status) {
    case 'ok':
      return { status: 'ok', ...result.value }
    case 'reconnect-required':
      return { status: 'reconnect-required' }
    case 'request-error':
      // 404: an auth deployment from before this route, or a provider with no MFA status.
      return result.error.statusCode === 404
        ? { status: 'unsupported' }
        : { status: 'failed', error: result.error.message }
    case 'failed':
      return { status: 'failed', error: result.error }
  }
}
