import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import { CrossMachineRecoveryPresentationStore } from './presentation-store'

let store: CrossMachineRecoveryPresentationStore | null = null

/** The profile's presentation store; created on first use because the profile path settles at ready. */
export function getCrossMachineRecoveryPresentationStore(): CrossMachineRecoveryPresentationStore {
  store ??= new CrossMachineRecoveryPresentationStore(getProfileUserDataPath())
  return store
}
