import type { OrcaProfileOrgMembersListResult } from '../../../shared/orca-profiles'
import type { ActiveOrcaProfileState } from '../profile-index-store'
import { ensureActiveOrcaProfile } from '../profile-index-store'
import type { OrcaCloudAuthConfig } from '../cloud-auth/profile-cloud-auth-config'
import {
  getOrcaCloudAuthConfig,
  isOrcaCloudDevAuthEnabled
} from '../cloud-auth/profile-cloud-auth-config'
import type { OrcaCloudSession } from '../cloud-session/profile-cloud-session-store'
import { OrcaCloudRequestError } from '../cloud-auth/profile-cloud-client'
import { runWithFreshOrcaCloudSession } from '../cloud-session/profile-cloud-session-refresh'
import { listOrcaCloudOrgMembers } from './profile-cloud-org-members-client'
import { listDevOrcaCloudOrgMembers } from './profile-cloud-dev-org-members'

export type OrgCallResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'reconnect-required' }
  | { status: 'request-error'; error: OrcaCloudRequestError }
  | { status: 'failed'; error: string }

// Only 401 should trigger session refresh; return business/permission failures as values.
export async function runOrgMemberCall<T>(
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
