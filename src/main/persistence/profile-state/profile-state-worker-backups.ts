import { ProfileStateBackupRotation } from './profile-state-backup-rotation'
import { runProfileStateBackupWorker } from './profile-state-backup-worker'
import type { ProfileStateWriterInitialization } from './profile-state-writer-protocol'

export function createProfileStateWorkerBackups(
  initialization: ProfileStateWriterInitialization,
  workerPath?: string
): ProfileStateBackupRotation {
  return new ProfileStateBackupRotation(
    initialization.databasePath,
    initialization.profileId,
    Date.now,
    (job, signal) => runProfileStateBackupWorker(job, { workerPath, signal })
  )
}
