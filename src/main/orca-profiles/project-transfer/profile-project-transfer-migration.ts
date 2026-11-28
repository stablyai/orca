import { newProfileSeededState } from '../../persistence/loading-store/profile-loading/new-profile-cohort-seeds'
import { migrateProfileStateToSqlite } from '../../persistence/profile-state/startup/profile-state-migration'
import { getOrcaProfileDataFile, getOrcaProfileStateDatabaseFile } from '../profile-storage-paths'
import type { ReadProfileStateResult } from './profile-project-state-file'
import {
  readProfileProjectTransferState,
  type ReadProfileProjectTransferResult
} from './profile-project-domain-state'

/** Adopt inactive storage without running Store's active-profile listeners or secret transforms. */
export function migrateProfileProjectTransferParticipant(
  profileId: string,
  userDataPath: string,
  snapshot: ReadProfileStateResult
): ReadProfileProjectTransferResult {
  const migrated = migrateProfileStateToSqlite({
    dataFile: getOrcaProfileDataFile(profileId, userDataPath),
    databaseFile: getOrcaProfileStateDatabaseFile(profileId, userDataPath),
    profileId,
    expectedLegacyJson: snapshot.serialized,
    // A target without state is new; '{}' would load as an existing profile.
    serializedState: snapshot.serialized ?? JSON.stringify(newProfileSeededState())
  })
  try {
    return readProfileProjectTransferState(profileId, userDataPath)
  } finally {
    migrated.authority.close()
  }
}
