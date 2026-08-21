import type { MCodeCloudAuthConfig } from './profile-cloud-auth-config'
import {
  MCodeCloudRequestError,
  refreshMCodeCloudSession,
  selectMCodeCloudOrg
} from './profile-cloud-client'
import { linkMCodeProfileToCloud } from './profile-cloud-index'
import type { ActiveMCodeProfileState } from './profile-index-store'
import {
  cloudSessionIdentity,
  recordCloudSessionIdentityMutation,
  recordCloudSessionIdentityMutationIfCurrent
} from './profile-cloud-session-mutation'
import {
  readMCodeCloudSession,
  saveMCodeCloudSessionIfCurrent,
  type MCodeCloudSession
} from './profile-cloud-session-store'

export async function selectCloudOrgWithMutationFence(input: {
  config: MCodeCloudAuthConfig
  active: ActiveMCodeProfileState
  userDataPath: string
  orgId: string
}): Promise<ReturnType<typeof linkMCodeProfileToCloud> | null> {
  const cloud = input.active.profile.cloud
  const stored = readMCodeCloudSession(input.active.profile.id, input.userDataPath)
  if (!cloud || stored.status !== 'found') {
    return null
  }
  const oldIdentity = cloudSessionIdentity(input.active.profile.id, cloud)
  const targetIdentity = {
    ...oldIdentity,
    organizationId: input.orgId
  }
  // Why: advance the durable identity fence before the first request. An old
  // refresh may finish, but its compare-and-save can no longer publish.
  const snapshot = recordCloudSessionIdentityMutation(targetIdentity, input.userDataPath)
  let workingSession: MCodeCloudSession = stored.session
  try {
    let selected
    try {
      selected = await selectMCodeCloudOrg(input.config, workingSession, input.orgId)
    } catch (error) {
      if (!(error instanceof MCodeCloudRequestError) || error.statusCode !== 401) {
        throw error
      }
      const refreshed = await refreshMCodeCloudSession(input.config, workingSession)
      if (
        refreshed.cloud.userId !== cloud.userId ||
        refreshed.cloud.cloudProfileId !== cloud.cloudProfileId
      ) {
        throw new Error('mcode_cloud_identity_changed_during_org_selection')
      }
      workingSession = {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
        organizations: refreshed.organizations,
        capabilities: refreshed.capabilities
      }
      selected = await selectMCodeCloudOrg(input.config, workingSession, input.orgId)
    }
    if (
      selected.cloud.userId !== cloud.userId ||
      selected.cloud.cloudProfileId !== cloud.cloudProfileId ||
      selected.cloud.activeOrgId !== input.orgId
    ) {
      throw new Error('mcode_cloud_org_selection_identity_mismatch')
    }
    const nextSession: MCodeCloudSession = {
      ...workingSession,
      organizations: selected.organizations ?? workingSession.organizations,
      capabilities: selected.capabilities
    }
    if (
      saveMCodeCloudSessionIfCurrent(
        input.active.profile.id,
        input.userDataPath,
        nextSession,
        snapshot
      ) === null
    ) {
      throw new Error('stale_cloud_session_mutation')
    }
    const list = linkMCodeProfileToCloud(input.active.profile.id, selected.cloud, input.userDataPath)
    return list
  } catch (error) {
    recordCloudSessionIdentityMutationIfCurrent(oldIdentity, input.userDataPath, snapshot)
    throw error
  }
}
