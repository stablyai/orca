import type {
  OrcaTeamMfaPolicy,
  OrcaTeamMfaPolicyResult,
  OrcaTeamMfaSelfState
} from '../../../shared/orca-team-mfa-policy'
import {
  getOrcaCloudAuthConfig,
  isOrcaCloudDevAuthEnabled
} from '../cloud-auth/profile-cloud-auth-config'
import { OrcaCloudRequestError } from '../cloud-auth/profile-cloud-client'
import {
  extractErrorCode,
  orgMembersUrl,
  requestInit
} from '../cloud-org/profile-cloud-org-members-client'
import {
  runOrgMemberCall,
  type OrgCallResult
} from '../cloud-org/profile-cloud-org-members-service'
import { ensureActiveOrcaProfile } from '../profile-index-store'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const SELF_STATES: readonly OrcaTeamMfaSelfState[] = [
  'on',
  'off',
  'pending',
  'blocked',
  'unknown',
  'delegated'
]

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** The setup link is opened in the browser, so only a page on Orca Cloud's own origin is kept. */
export function sameOriginUrl(value: unknown, apiBaseUrl: string): string | null {
  if (typeof value !== 'string') {
    return null
  }
  try {
    const url = new URL(value)
    return url.origin === new URL(apiBaseUrl).origin && !url.username && !url.password
      ? url.toString()
      : null
  } catch {
    return null
  }
}

function normalizeDeadline(value: unknown): { enforceAt: number; setAt: number } | null {
  const record = isRecord(value) ? value : null
  const enforceAt = finiteNumber(record?.enforceAt)
  const setAt = finiteNumber(record?.setAt)
  return enforceAt !== null && setAt !== null ? { enforceAt, setAt } : null
}

export function normalizeTeamMfaPolicy(value: unknown, apiBaseUrl: string): OrcaTeamMfaPolicy {
  const record = isRecord(value) ? value : null
  const setupUrl = sameOriginUrl(record?.setupUrl, apiBaseUrl)
  if (!record || !setupUrl) {
    throw new Error('invalid_orca_team_mfa_policy')
  }
  const selfRecord = isRecord(record.self) ? record.self : {}
  // An unrecognized state is "unknown", never "blocked": only the server's word blocks anyone.
  const self = SELF_STATES.find((state) => state === selfRecord.mfa) ?? 'unknown'
  return {
    policy: normalizeDeadline(record.policy),
    self,
    setupUrl
  }
}

async function request(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init)
  if (!response.ok) {
    throw new OrcaCloudRequestError(response.status, await extractErrorCode(response))
  }
  const body: unknown = await response.json()
  return body
}

type Unavailable = Extract<
  OrcaTeamMfaPolicyResult,
  {
    status:
      | 'unconfigured'
      | 'reconnect-required'
      | 'unsupported'
      | 'forbidden'
      | 'rate-limited'
      | 'failed'
  }
>

function unavailable(result: Exclude<OrgCallResult<unknown>, { status: 'ok' }>): Unavailable {
  if (result.status === 'reconnect-required') {
    return { status: 'reconnect-required' }
  }
  if (result.status === 'failed') {
    return { status: 'failed', error: result.error }
  }
  const { statusCode, errorCode, message } = result.error
  if (statusCode === 404 && !errorCode) {
    // No JSON error: an auth deployment from before these routes.
    return { status: 'unsupported' }
  }
  if (statusCode === 403) {
    return { status: 'forbidden' }
  }
  if (statusCode === 429) {
    return { status: 'rate-limited' }
  }
  return { status: 'failed', error: message }
}

async function call<T>(
  userDataPath: string,
  run: (apiBaseUrl: string, accessToken: string, url: (path: string) => string) => Promise<T>,
  orgId: string
): Promise<OrgCallResult<T> | { status: 'unconfigured' } | { status: 'unsupported' }> {
  const active = ensureActiveOrcaProfile(userDataPath)
  // Local dev auth has no server, so no policy.
  if (isOrcaCloudDevAuthEnabled()) {
    return { status: 'unsupported' }
  }
  const configState = getOrcaCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  const { config } = configState
  return runOrgMemberCall(config, active, userDataPath, (session) =>
    run(config.apiBaseUrl, session.accessToken, (path) => orgMembersUrl(config, orgId, path))
  )
}

export async function getOrcaTeamMfaPolicy(
  userDataPath: string,
  orgId: string
): Promise<OrcaTeamMfaPolicyResult> {
  const result = await call(
    userDataPath,
    async (apiBaseUrl, token, url) =>
      normalizeTeamMfaPolicy(
        await request(url('/mfa-policy'), requestInit('GET', token)),
        apiBaseUrl
      ),
    orgId
  )
  if (result.status === 'ok') {
    return { status: 'ok', ...result.value }
  }
  return result.status === 'unconfigured' || result.status === 'unsupported'
    ? result
    : unavailable(result)
}
