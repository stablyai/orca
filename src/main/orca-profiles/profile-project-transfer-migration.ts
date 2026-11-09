import { migrateProfileStateToSqlite } from '../persistence/profile-state/profile-state-migration'
import { getOrcaProfileDataFile, getOrcaProfileStateDatabaseFile } from './profile-storage-paths'
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
    serializedState: snapshot.serialized ?? '{}'
  })
  try {
    return readProfileProjectTransferState(profileId, userDataPath)
  } finally {
    migrated.authority.close()
  }
}
