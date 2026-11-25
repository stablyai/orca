import { ORCA_CLOUD_TEAM_POLICY_FLAGS } from '../../shared/orca-profiles/orca-cloud-team-policy'
import { getActiveTeamCapabilities } from '../orca-profiles/cloud-auth/active-team-capabilities'
import { RuntimeClientError } from './runtime-client-error'

export function assertTeamAllowsComputerUse(): void {
  if (getActiveTeamCapabilities()?.flags[ORCA_CLOUD_TEAM_POLICY_FLAGS.computerUse] === false) {
    throw new RuntimeClientError(
      'computer_use_disabled',
      'Computer Use is turned off by your team.'
    )
  }
}
