import {
  ORCA_TEAM_MFA_GRACE_CHOICES,
  type OrcaTeamMfaGrace,
  type OrcaTeamMfaPendingMember,
  type OrcaTeamMfaPendingResult,
  type OrcaTeamMfaPolicy,
  type OrcaTeamMfaPolicyResult,
  type OrcaTeamMfaPolicySetResult,
  type OrcaTeamMfaRemindResult,
  type OrcaTeamMfaSelfState
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

const SELF_STATES: readonly OrcaTeamMfaSelfState[] = ['on', 'off', 'pending', 'blocked', 'unknown']

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
  const pendingMembers = finiteNumber(record.pendingMembers)
  const inactive = isRecord(record.inactivePolicy)
    ? finiteNumber(record.inactivePolicy.enforceAt)
    : null
  return {
    policy: normalizeDeadline(record.policy),
    self,
    setupUrl,
    // Present only when the server sent the manager fields; a member's answer has none.
    ...(typeof record.available === 'boolean'
      ? {
          manage: {
            available: record.available,
            pendingMembers: pendingMembers ?? 0,
            ...(inactive !== null ? { inactiveEnforceAt: inactive } : {})
          }
        }
      : {})
  }
}

export function normalizePendingMembers(value: unknown): OrcaTeamMfaPendingMember[] {
  const record = isRecord(value) ? value : null
  const members = Array.isArray(record?.members) ? record.members : []
  return members.flatMap((entry): OrcaTeamMfaPendingMember[] => {
    const member = isRecord(entry) ? entry : null
    const email = typeof member?.email === 'string' ? member.email.trim() : ''
    if (!member || !email) {
      return []
    }
    const displayName = typeof member.displayName === 'string' ? member.displayName.trim() : ''
    return [
      {
        userId: typeof member.userId === 'string' && member.userId ? member.userId : null,
        email,
        ...(displayName ? { displayName } : {}),
        mfa: member.mfa === 'blocked' ? 'blocked' : member.mfa === 'pending' ? 'pending' : 'off'
      }
    ]
  })
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

export async function setOrcaTeamMfaPolicy(
  userDataPath: string,
  args: { orgId: string; enforce: OrcaTeamMfaGrace | 'off' }
): Promise<OrcaTeamMfaPolicySetResult> {
  if (args.enforce !== 'off' && !ORCA_TEAM_MFA_GRACE_CHOICES.includes(args.enforce)) {
    return { status: 'failed', error: 'invalid_enforce' }
  }
  const result = await call(
    userDataPath,
    async (_apiBaseUrl, token, url) => {
      const init =
        args.enforce === 'off'
          ? { ...requestInit('GET', token), method: 'DELETE' }
          : { ...requestInit('POST', token, { enforce: args.enforce }), method: 'PUT' }
      const answer = await request(url('/mfa-policy'), init)
      const body = isRecord(answer) ? answer : null
      return {
        policy: normalizeDeadline(body?.policy),
        pendingMembers: finiteNumber(body?.pendingMembers) ?? 0
      }
    },
    args.orgId
  )
  if (result.status === 'ok') {
    return { status: 'ok', ...result.value }
  }
  if (result.status === 'unconfigured' || result.status === 'unsupported') {
    return result
  }
  if (result.status === 'request-error') {
    const { errorCode } = result.error
    if (errorCode === 'actor_needs_mfa') {
      return { status: 'actor-needs-mfa' }
    }
    if (errorCode === 'mfa_enforcement_not_entitled') {
      return { status: 'not-entitled' }
    }
  }
  return unavailable(result)
}

export async function listOrcaTeamMfaPending(
  userDataPath: string,
  orgId: string
): Promise<OrcaTeamMfaPendingResult> {
  const result = await call(
    userDataPath,
    async (_apiBaseUrl, token, url) =>
      normalizePendingMembers(await request(url('/mfa-policy/pending'), requestInit('GET', token))),
    orgId
  )
  if (result.status === 'ok') {
    return { status: 'ok', members: result.value }
  }
  return result.status === 'unconfigured' || result.status === 'unsupported'
    ? result
    : unavailable(result)
}

export async function remindOrcaTeamMfa(
  userDataPath: string,
  args: { orgId: string; userId?: string }
): Promise<OrcaTeamMfaRemindResult> {
  const result = await call(
    userDataPath,
    async (_apiBaseUrl, token, url) => {
      const answer = await request(
        url('/mfa-policy/remind'),
        requestInit('POST', token, args.userId ? { userId: args.userId } : {})
      )
      const body = isRecord(answer) ? answer : null
      const delivery: 'log' | 'test-inbox' | 'unknown' =
        body?.delivery === 'log' || body?.delivery === 'test-inbox' ? body.delivery : 'unknown'
      return { recipients: finiteNumber(body?.recipients) ?? 0, delivery }
    },
    args.orgId
  )
  if (result.status === 'ok') {
    return { status: 'ok', ...result.value }
  }
  if (result.status === 'unconfigured' || result.status === 'unsupported') {
    return result
  }
  if (result.status === 'request-error') {
    if (result.error.errorCode === 'no_policy') {
      return { status: 'no-policy' }
    }
    if (result.error.errorCode === 'member_not_found') {
      return { status: 'not-found' }
    }
  }
  return unavailable(result)
}
