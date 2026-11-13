import type { OrcaCloudAuthConfig } from '../cloud-auth/profile-cloud-auth-config'
import { OrcaCloudRequestError, selectOrcaCloudOrg } from '../cloud-auth/profile-cloud-client'
import { forceRefreshOrcaCloudSession } from '../cloud-session/profile-cloud-session-refresh'
import type { ActiveOrcaProfileState } from '../profile-index-store'
import type { OrcaProfileListState } from '../../../shared/orca-profiles'
import { bumpOrcaCloudTokenEpoch } from '../cloud-token-epoch'
import {
  beginCloudSessionRelink,
  commitCloudSessionRelink,
  readCloudSession
} from '../cloud-session/profile-cloud-session-owner'

export const ORG_SWITCH_REFRESH_FAILED =
  "Couldn't refresh your Orca sign-in for the new team. Try again, or sign out and back in."

export async function selectCloudOrg(input: {
  config: OrcaCloudAuthConfig
  active: ActiveOrcaProfileState
  userDataPath: string
  /** null clears the selection (personal account). */
  orgId: string | null
}): Promise<OrcaProfileListState | null> {
  const profileId = input.active.profile.id
  const cloud = input.active.profile.cloud
  const stored = readCloudSession(profileId, input.userDataPath)
  if (!cloud || stored.status !== 'found') {
    return null
  }
  const ticket = beginCloudSessionRelink(profileId, input.userDataPath)
  let selected
  try {
    selected = await selectOrcaCloudOrg(input.config, stored.session, input.orgId)
  } catch (error) {
    if (!(error instanceof OrcaCloudRequestError) || error.statusCode !== 401) {
      throw error
    }
    const refreshed = await forceRefreshOrcaCloudSession(
      input.config,
      input.active,
      input.userDataPath,
      stored.session
    )
    if (refreshed.status !== 'found') {
      throw error
    }
    selected = await selectOrcaCloudOrg(input.config, refreshed.session, input.orgId)
  }
  if (
    selected.cloud.userId !== cloud.userId ||
    selected.cloud.cloudProfileId !== cloud.cloudProfileId ||
    (selected.cloud.activeOrgId ?? null) !== input.orgId
  ) {
    throw new Error('orca_cloud_org_selection_identity_mismatch')
  }
  // Why: /auth/org updates the stored selection but not the access token, and auth (sandbox
  // tokens included) reads the team from it. Publishing the new activeOrgId before the token
  // follows lets a mint in between cache an old-team token under the new team. So refresh first,
  // and commit only once the session speaks for the new team; a failed refresh fails the switch.
  const current = readCloudSession(profileId, input.userDataPath)
  if (current.status !== 'found') {
    throw new Error(ORG_SWITCH_REFRESH_FAILED)
  }
  const refreshed = await forceRefreshOrcaCloudSession(
    input.config,
    input.active,
    input.userDataPath,
    current.session
  )
  if (refreshed.status !== 'found') {
    throw new Error(ORG_SWITCH_REFRESH_FAILED)
  }
  const list = commitCloudSessionRelink(profileId, input.userDataPath, ticket, selected)
  if (!list) {
    throw new Error('stale_cloud_session_mutation')
  }
  // Drop every cached sandbox token minted for the previous team.
  bumpOrcaCloudTokenEpoch()
  return list
}
