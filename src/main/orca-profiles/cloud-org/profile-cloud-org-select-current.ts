import type {
  OrcaProfileAuthStatus,
  SelectOrcaProfileOrgResult
} from '../../../shared/orca-profiles/orca-profiles'
import { ensureActiveOrcaProfile } from '../profile-index-store'
import {
  getOrcaCloudAuthConfig,
  isOrcaCloudDevAuthEnabled
} from '../cloud-auth/profile-cloud-auth-config'
import { selectDevOrcaCloudOrg } from '../cloud-auth/profile-cloud-dev-service'
import { getOrcaProfileAuthStatusFromProfile } from '../cloud-auth/profile-cloud-auth-status'
import { selectCloudOrg } from './profile-cloud-org-selection'

function getCurrentOrcaProfileAuthStatus(userDataPath: string): OrcaProfileAuthStatus {
  return getOrcaProfileAuthStatusFromProfile(ensureActiveOrcaProfile(userDataPath), userDataPath)
}

export async function selectCurrentOrcaProfileOrg(
  userDataPath: string,
  orgId: string | null
): Promise<SelectOrcaProfileOrgResult> {
  const active = ensureActiveOrcaProfile(userDataPath)
  if (isOrcaCloudDevAuthEnabled()) {
    const result = selectDevOrcaCloudOrg(active, userDataPath, orgId)
    if (result.status !== 'updated') {
      return {
        status: 'reconnect-required',
        auth: getOrcaProfileAuthStatusFromProfile(active, userDataPath)
      }
    }
    return {
      status: 'selected',
      auth: getCurrentOrcaProfileAuthStatus(userDataPath),
      activeProfileId: result.list.activeProfileId,
      profiles: result.list.profiles
    }
  }

  const configState = getOrcaCloudAuthConfig()
  if (!configState.configured) {
    return {
      status: 'unconfigured',
      auth: getOrcaProfileAuthStatusFromProfile(active, userDataPath)
    }
  }
  try {
    const list = await selectCloudOrg({
      config: configState.config,
      active,
      userDataPath,
      orgId
    })
    if (!list) {
      return {
        status: 'reconnect-required',
        auth: getOrcaProfileAuthStatusFromProfile(active, userDataPath)
      }
    }
    return {
      status: 'selected',
      auth: getCurrentOrcaProfileAuthStatus(userDataPath),
      activeProfileId: list.activeProfileId,
      profiles: list.profiles
    }
  } catch (error) {
    return {
      status: 'failed',
      auth: getCurrentOrcaProfileAuthStatus(userDataPath),
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
