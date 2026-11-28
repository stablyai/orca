import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import { ACP_LAUNCH_SPECS } from '../launch/acp-launch-registry'
import { sweepAcpTextTaskHomes } from './acp-text-task-launch'

/** Text task homes a crash or a failed removal left in this profile's data folder. */
export function sweepAcpTextTaskHomesAtLaunch(): Promise<void> {
  return sweepAcpTextTaskHomes(getProfileUserDataPath(), ACP_LAUNCH_SPECS)
}
