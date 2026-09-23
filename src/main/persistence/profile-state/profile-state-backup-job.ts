import { openProfileStateDatabaseReadOnly } from './profile-state-database'
import { writeProfileStateDatabaseSnapshotAsync } from './profile-state-database-snapshot'
import { validateProfileStateSnapshot } from './profile-state-documents'

export type ProfileStateBackupJob = {
  databasePath: string
  profileId: string
  targetPath: string
}

/** Own every connection until the copy and its strict validation finish. */
export async function writeProfileStateBackup(job: ProfileStateBackupJob): Promise<void> {
  const opened = openProfileStateDatabaseReadOnly(job.databasePath, job.profileId)
  try {
    await writeProfileStateDatabaseSnapshotAsync(opened.db, job.targetPath, {
      validateStagedSnapshot: (stagingPath) =>
        validateProfileStateBackup(stagingPath, job.profileId)
    })
  } finally {
    opened.db.close()
  }
}

function validateProfileStateBackup(path: string, profileId: string): void {
  const snapshot = openProfileStateDatabaseReadOnly(path, profileId)
  try {
    validateProfileStateSnapshot(snapshot.db)
  } finally {
    snapshot.db.close()
  }
}
