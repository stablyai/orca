import { migrateProfileStateToSqlite } from '../../persistence/profile-state/startup/profile-state-migration'
import { seedNewProfileLinkMode } from '../../persistence/loading-store/profile-loading/loaded-cohort-migrations'
import { getOrcaProfileDataFile, getOrcaProfileStateDatabaseFile } from '../profile-storage-paths'
import type { ReadProfileStateResult } from './profile-project-state-file'
import {
  readProfileProjectTransferState,
  type ReadProfileProjectTransferResult
} from './profile-project-domain-state'

// Transfer normalization erases the raw evidence that this profile was never opened, so seed it first.
function seedNeverOpenedProfile(serialized: string | undefined): string {
  if (serialized === undefined) {
    return JSON.stringify(seedNewProfileLinkMode(undefined))
  }
  let root: unknown
  try {
    root = JSON.parse(serialized)
  } catch {
    // Migration rejects invalid JSON itself.
    return serialized
  }
  const seeded = isRecord(root) ? seedNewProfileLinkMode(root) : undefined
  return seeded ? JSON.stringify(seeded) : serialized
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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
    serializedState: seedNeverOpenedProfile(snapshot.serialized)
  })
  try {
    return readProfileProjectTransferState(profileId, userDataPath)
  } finally {
    migrated.authority.close()
  }
}
