import type {
  OrcaProfileOrgInviteRevokeArgs,
  OrcaProfileOrgMemberChangeRoleArgs,
  OrcaProfileOrgMemberInviteArgs,
  OrcaProfileOrgMemberMutationResult,
  OrcaProfileOrgMemberRemoveArgs,
  OrcaProfileOrgMembersListResult
} from '../../shared/orca-profiles'
import type { ActiveOrcaProfileState } from './profile-index-store'
import { ensureActiveOrcaProfile } from './profile-index-store'
import type { OrcaCloudAuthConfig } from './profile-cloud-auth-config'
import { getOrcaCloudAuthConfig, isOrcaCloudDevAuthEnabled } from './profile-cloud-auth-config'
import type { OrcaCloudSession } from './profile-cloud-session-store'
import { OrcaCloudRequestError } from './profile-cloud-client'
import { runWithFreshOrcaCloudSession } from './profile-cloud-session-refresh'
import {
  changeOrcaCloudOrgMemberRole,
  inviteOrcaCloudOrgMember,
  listOrcaCloudOrgMembers,
  removeOrcaCloudOrgMember,
  revokeOrcaCloudOrgInvite
} from './profile-cloud-org-members-client'
import {
  changeDevOrcaCloudOrgMemberRole,
  inviteDevOrcaCloudOrgMember,
  listDevOrcaCloudOrgMembers,
  removeDevOrcaCloudOrgMember,
  revokeDevOrcaCloudOrgInvite
} from './profile-cloud-dev-org-members'

type OrgCallResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'reconnect-required' }
  | { status: 'request-error'; error: OrcaCloudRequestError }
  | { status: 'failed'; error: string }

// Why: only a 401 means the token itself is stale and should drive a session
// refresh/reconnect. 403/404/409/400 are business or permission outcomes the UI
// must interpret, so they are surfaced as values rather than thrown — otherwise
// runWithFreshOrcaCloudSession would treat a 403 as an auth failure and burn a
// pointless token refresh + retry before giving up.
async function runOrgMemberCall<T>(
  config: OrcaCloudAuthConfig,
  active: ActiveOrcaProfileState,
  userDataPath: string,
  call: (session: OrcaCloudSession) => Promise<T>
): Promise<OrgCallResult<T>> {
  try {
    const operation = await runWithFreshOrcaCloudSession(
      config,
      active,
      userDataPath,
      async (session) => {
        try {
          return { ok: true as const, value: await call(session) }
        } catch (error) {
          if (error instanceof OrcaCloudRequestError && error.statusCode !== 401) {
            return { ok: false as const, error }
          }
          throw error
        }
      }
    )
    if (operation.status !== 'ok') {
      return { status: 'reconnect-required' }
    }
    const outcome = operation.value
    return outcome.ok
      ? { status: 'ok', value: outcome.value }
      : { status: 'request-error', error: outcome.error }
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}

function mapMutationRequestError(error: OrcaCloudRequestError): OrcaProfileOrgMemberMutationResult {
  switch (error.statusCode) {
    case 403:
      return { status: 'forbidden' }
    case 404:
      return { status: 'not-found' }
    case 409:
      return {
        status: 'conflict',
        reason: error.errorCode === 'already_member' ? 'already_member' : 'already_invited'
      }
    case 400:
      return {
        status: 'invalid',
        reason:
          error.errorCode === 'cannot_remove_self' ? 'cannot_remove_self' : 'cannot_change_own_role'
      }
    default:
      return { status: 'failed', error: error.message }
  }
}

function mapMutationResult(result: OrgCallResult<void>): OrcaProfileOrgMemberMutationResult {
  switch (result.status) {
    case 'ok':
      return { status: 'ok' }
    case 'reconnect-required':
      return { status: 'reconnect-required' }
    case 'request-error':
      return mapMutationRequestError(result.error)
    case 'failed':
      return { status: 'failed', error: result.error }
  }
}

export async function listOrcaProfileOrgMembers(
  userDataPath: string,
  orgId: string
): Promise<OrcaProfileOrgMembersListResult> {
  const active = ensureActiveOrcaProfile(userDataPath)
  if (isOrcaCloudDevAuthEnabled()) {
    return { status: 'ok', roster: listDevOrcaCloudOrgMembers(orgId) }
  }
  const configState = getOrcaCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  const result = await runOrgMemberCall(configState.config, active, userDataPath, (session) =>
    listOrcaCloudOrgMembers(configState.config, session, orgId)
  )
  switch (result.status) {
    case 'ok':
      return { status: 'ok', roster: result.value }
    case 'reconnect-required':
      return { status: 'reconnect-required' }
    case 'request-error':
      return { status: 'failed', error: result.error.message }
    case 'failed':
      return { status: 'failed', error: result.error }
  }
}

export async function inviteOrcaProfileOrgMember(
  userDataPath: string,
  args: OrcaProfileOrgMemberInviteArgs
): Promise<OrcaProfileOrgMemberMutationResult> {
  const active = ensureActiveOrcaProfile(userDataPath)
  if (isOrcaCloudDevAuthEnabled()) {
    return inviteDevOrcaCloudOrgMember(args)
  }
  const configState = getOrcaCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  return mapMutationResult(
    await runOrgMemberCall(configState.config, active, userDataPath, (session) =>
      inviteOrcaCloudOrgMember(configState.config, session, args)
    )
  )
}

export async function revokeOrcaProfileOrgInvite(
  userDataPath: string,
  args: OrcaProfileOrgInviteRevokeArgs
): Promise<OrcaProfileOrgMemberMutationResult> {
  const active = ensureActiveOrcaProfile(userDataPath)
  if (isOrcaCloudDevAuthEnabled()) {
    return revokeDevOrcaCloudOrgInvite(args)
  }
  const configState = getOrcaCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  return mapMutationResult(
    await runOrgMemberCall(configState.config, active, userDataPath, (session) =>
      revokeOrcaCloudOrgInvite(configState.config, session, args)
    )
  )
}

export async function changeOrcaProfileOrgMemberRole(
  userDataPath: string,
  args: OrcaProfileOrgMemberChangeRoleArgs
): Promise<OrcaProfileOrgMemberMutationResult> {
  const active = ensureActiveOrcaProfile(userDataPath)
  if (isOrcaCloudDevAuthEnabled()) {
    return changeDevOrcaCloudOrgMemberRole(args)
  }
  const configState = getOrcaCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  return mapMutationResult(
    await runOrgMemberCall(configState.config, active, userDataPath, (session) =>
      changeOrcaCloudOrgMemberRole(configState.config, session, args)
    )
  )
}

export async function removeOrcaProfileOrgMember(
  userDataPath: string,
  args: OrcaProfileOrgMemberRemoveArgs
): Promise<OrcaProfileOrgMemberMutationResult> {
  const active = ensureActiveOrcaProfile(userDataPath)
  if (isOrcaCloudDevAuthEnabled()) {
    return removeDevOrcaCloudOrgMember(args)
  }
  const configState = getOrcaCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  return mapMutationResult(
    await runOrgMemberCall(configState.config, active, userDataPath, (session) =>
      removeOrcaCloudOrgMember(configState.config, session, args)
    )
  )
}
