import { hasAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import type { OrcaCloudCapabilities } from '../../../shared/orca-profiles/orca-cloud-capabilities'
import { ORCA_CLOUD_TEAM_SETTINGS } from '../../../shared/orca-profiles/orca-cloud-team-policy'
import { sessionBelongsToProfile } from '../cloud-session/profile-cloud-session-identity'
import { readCloudSession } from '../cloud-session/profile-cloud-session-owner'
import { readProfileIndex } from '../profile-index-store'
import { getOrcaProfileIndexPath, getProfileUserDataPath } from '../profile-storage-paths'
import { teamCapabilitiesGeneration } from './team-capabilities-invalidation'

let cached:
  | { root: string; generation: number; capabilities: OrcaCloudCapabilities | undefined }
  | undefined

export function getActiveTeamCapabilities(): OrcaCloudCapabilities | undefined {
  if (!hasAppEnvironment()) {
    return undefined
  }
  const userDataPath = getProfileUserDataPath()
  const generation = teamCapabilitiesGeneration()
  if (cached?.root === userDataPath && cached.generation === generation) {
    return cached.capabilities
  }
  const capabilities = readActiveTeamCapabilities(userDataPath)
  cached = { root: userDataPath, generation, capabilities }
  return capabilities
}

function readActiveTeamCapabilities(userDataPath: string): OrcaCloudCapabilities | undefined {
  const index = readProfileIndex(getOrcaProfileIndexPath(userDataPath))
  const profile = index?.profiles.find((entry) => entry.id === index.activeProfileId)
  const cloud = profile?.cloud
  if (!profile || !cloud?.activeOrgId) {
    return undefined
  }

  const result = readCloudSession(profile.id, userDataPath)
  if (result.status !== 'found' || !sessionBelongsToProfile(result.session, cloud)) {
    return undefined
  }
  const { capabilities } = result.session
  if (
    capabilities.flags[ORCA_CLOUD_TEAM_SETTINGS] === true &&
    capabilities.teamPolicy?.orgId === cloud.activeOrgId
  ) {
    return capabilities
  }
  return undefined
}
