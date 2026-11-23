import type { OrcaProfileSummary } from '../../../shared/orca-profiles/orca-profiles'
import { readStoredTeamPolicySession } from '../cloud-session/profile-cloud-session-store'
import { initializeActiveTeamProfile } from './active-team-capabilities'

export async function initializeTeamCapabilities(
  userDataPath: string,
  profile: OrcaProfileSummary
): Promise<void> {
  const finish = initializeActiveTeamProfile(userDataPath, profile)
  if (profile.cloud) {
    finish(await readStoredTeamPolicySession(profile.id, userDataPath))
  }
}
