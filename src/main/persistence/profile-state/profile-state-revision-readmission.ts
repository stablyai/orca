import { openProfileStateDatabaseReadOnly } from './profile-state-database'
import { readProfileStateRevision } from './profile-state-documents'
import { ProfileStateRevisionConflictError } from './profile-state-document-validation'

/** Reopening a live snapshot cannot adopt another writer's intervening revision. */
export function assertProfileStateRevisionOnDisk(
  databasePath: string,
  profileId: string,
  revision: number
): void {
  const admitted = openProfileStateDatabaseReadOnly(databasePath, profileId)
  try {
    const actual = readProfileStateRevision(admitted.db)
    if (actual !== revision) {
      throw new ProfileStateRevisionConflictError(revision, actual)
    }
  } finally {
    admitted.db.close()
  }
}
