import type { OrcaProfileIndex, OrcaProfileListState } from '../../shared/orca-profiles'
import { getOrcaProfileIndexPath, getProfileUserDataPath } from './profile-storage-paths'

const snapshots = new Map<string, OrcaProfileListState>()

export function publishOrcaProfileListSnapshot(indexPath: string, index: OrcaProfileIndex): void {
  snapshots.set(indexPath, {
    activeProfileId: index.activeProfileId,
    profiles: index.profiles
  })
}

export function getOrcaProfileListSnapshot(
  userDataPath = getProfileUserDataPath()
): OrcaProfileListState {
  const snapshot = snapshots.get(getOrcaProfileIndexPath(userDataPath))
  if (!snapshot) {
    throw new Error('orca_profile_list_unavailable')
  }
  return snapshot
}
