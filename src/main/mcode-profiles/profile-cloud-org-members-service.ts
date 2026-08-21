import type {
  MCodeProfileOrgInviteRevokeArgs,
  MCodeProfileOrgMemberChangeRoleArgs,
  MCodeProfileOrgMemberInviteArgs,
  MCodeProfileOrgMemberMutationResult,
  MCodeProfileOrgMemberRemoveArgs,
  MCodeProfileOrgMembersListResult
} from '../../shared/mcode-profiles'
import type { ActiveMCodeProfileState } from './profile-index-store'
import { ensureActiveMCodeProfile } from './profile-index-store'
import type { MCodeCloudAuthConfig } from './profile-cloud-auth-config'
import { getMCodeCloudAuthConfig, isMCodeCloudDevAuthEnabled } from './profile-cloud-auth-config'
import type { MCodeCloudSession } from './profile-cloud-session-store'
import { MCodeCloudRequestError } from './profile-cloud-client'
import { runWithFreshMCodeCloudSession } from './profile-cloud-session-refresh'
import {
  changeMCodeCloudOrgMemberRole,
  inviteMCodeCloudOrgMember,
  listMCodeCloudOrgMembers,
  removeMCodeCloudOrgMember,
  revokeMCodeCloudOrgInvite
} from './profile-cloud-org-members-client'
import {
  changeDevMCodeCloudOrgMemberRole,
  inviteDevMCodeCloudOrgMember,
  listDevMCodeCloudOrgMembers,
  removeDevMCodeCloudOrgMember,
  revokeDevMCodeCloudOrgInvite
} from './profile-cloud-dev-org-members'

type OrgCallResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'reconnect-required' }
  | { status: 'request-error'; error: MCodeCloudRequestError }
  | { status: 'failed'; error: string }

// Why: only a 401 means the token itself is stale and should drive a session
// refresh/reconnect. 403/404/409/400 are business or permission outcomes the UI
// must interpret, so they are surfaced as values rather than thrown — otherwise
// runWithFreshMCodeCloudSession would treat a 403 as an auth failure and burn a
// pointless token refresh + retry before giving up.
async function runOrgMemberCall<T>(
  config: MCodeCloudAuthConfig,
  active: ActiveMCodeProfileState,
  userDataPath: string,
  call: (session: MCodeCloudSession) => Promise<T>
): Promise<OrgCallResult<T>> {
  try {
    const operation = await runWithFreshMCodeCloudSession(
      config,
      active,
      userDataPath,
      async (session) => {
        try {
          return { ok: true as const, value: await call(session) }
        } catch (error) {
          if (error instanceof MCodeCloudRequestError && error.statusCode !== 401) {
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

function mapMutationRequestError(error: MCodeCloudRequestError): MCodeProfileOrgMemberMutationResult {
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

function mapMutationResult(result: OrgCallResult<void>): MCodeProfileOrgMemberMutationResult {
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

export async function listMCodeProfileOrgMembers(
  userDataPath: string,
  orgId: string
): Promise<MCodeProfileOrgMembersListResult> {
  const active = ensureActiveMCodeProfile(userDataPath)
  if (isMCodeCloudDevAuthEnabled()) {
    return { status: 'ok', roster: listDevMCodeCloudOrgMembers(orgId) }
  }
  const configState = getMCodeCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  const result = await runOrgMemberCall(configState.config, active, userDataPath, (session) =>
    listMCodeCloudOrgMembers(configState.config, session, orgId)
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

export async function inviteMCodeProfileOrgMember(
  userDataPath: string,
  args: MCodeProfileOrgMemberInviteArgs
): Promise<MCodeProfileOrgMemberMutationResult> {
  const active = ensureActiveMCodeProfile(userDataPath)
  if (isMCodeCloudDevAuthEnabled()) {
    return inviteDevMCodeCloudOrgMember(args)
  }
  const configState = getMCodeCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  return mapMutationResult(
    await runOrgMemberCall(configState.config, active, userDataPath, (session) =>
      inviteMCodeCloudOrgMember(configState.config, session, args)
    )
  )
}

export async function revokeMCodeProfileOrgInvite(
  userDataPath: string,
  args: MCodeProfileOrgInviteRevokeArgs
): Promise<MCodeProfileOrgMemberMutationResult> {
  const active = ensureActiveMCodeProfile(userDataPath)
  if (isMCodeCloudDevAuthEnabled()) {
    return revokeDevMCodeCloudOrgInvite(args)
  }
  const configState = getMCodeCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  return mapMutationResult(
    await runOrgMemberCall(configState.config, active, userDataPath, (session) =>
      revokeMCodeCloudOrgInvite(configState.config, session, args)
    )
  )
}

export async function changeMCodeProfileOrgMemberRole(
  userDataPath: string,
  args: MCodeProfileOrgMemberChangeRoleArgs
): Promise<MCodeProfileOrgMemberMutationResult> {
  const active = ensureActiveMCodeProfile(userDataPath)
  if (isMCodeCloudDevAuthEnabled()) {
    return changeDevMCodeCloudOrgMemberRole(args)
  }
  const configState = getMCodeCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  return mapMutationResult(
    await runOrgMemberCall(configState.config, active, userDataPath, (session) =>
      changeMCodeCloudOrgMemberRole(configState.config, session, args)
    )
  )
}

export async function removeMCodeProfileOrgMember(
  userDataPath: string,
  args: MCodeProfileOrgMemberRemoveArgs
): Promise<MCodeProfileOrgMemberMutationResult> {
  const active = ensureActiveMCodeProfile(userDataPath)
  if (isMCodeCloudDevAuthEnabled()) {
    return removeDevMCodeCloudOrgMember(args)
  }
  const configState = getMCodeCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  return mapMutationResult(
    await runOrgMemberCall(configState.config, active, userDataPath, (session) =>
      removeMCodeCloudOrgMember(configState.config, session, args)
    )
  )
}
