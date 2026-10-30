import type { OrcaCloudAuthConfig } from './profile-cloud-auth-config'
import { OrcaCloudRequestError, selectOrcaCloudOrg } from './profile-cloud-client'
import { forceRefreshOrcaCloudSession } from './profile-cloud-session-refresh'
import type { ActiveOrcaProfileState } from './profile-index-store'
import type { OrcaProfileListState } from '../../shared/orca-profiles'
import {
  beginCloudSessionRelink,
  commitCloudSessionRelink,
  readCloudSession
} from './profile-cloud-session-owner'

export async function selectCloudOrg(input: {
  config: OrcaCloudAuthConfig
  active: ActiveOrcaProfileState
  userDataPath: string
  orgId: string
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
    selected.cloud.activeOrgId !== input.orgId
  ) {
    throw new Error('orca_cloud_org_selection_identity_mismatch')
  }
  const list = commitCloudSessionRelink(profileId, input.userDataPath, ticket, selected)
  if (!list) {
    throw new Error('stale_cloud_session_mutation')
  }
  return list
}
