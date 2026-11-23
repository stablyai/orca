import type { ProfileStateWriterInitialization } from './profile-state-writer-protocol'
import { profileStateWriterFailureOutcome } from './profile-state-writer-errors'
import { ProfileStateWriteWorkerClient } from './profile-state-writer-worker-client'
import type { ProfileStateWorkerAuthorityOptions } from '../profile-state-worker-authority'
import {
  isPermanentProfileStateOpenFailure,
  isProfileStateRevisionConflict,
  type ProfileStateWriterReopenPolicy
} from './profile-state-writer-reopen-policy'
import { isProfileStateSaveCommand } from './profile-state-writer-request'

export function createProfileStateWriter(
  initialization: ProfileStateWriterInitialization,
  options: ProfileStateWorkerAuthorityOptions,
  reportInitializationFailure: boolean,
  policy: ProfileStateWriterReopenPolicy,
  onIndeterminateFailure: (
    writer: ProfileStateWriteWorkerClient,
    error: Error,
    interruptedSave: boolean
  ) => void
): ProfileStateWriteWorkerClient {
  let writer: ProfileStateWriteWorkerClient
  const generation = policy.beginWriter()
  writer = new ProfileStateWriteWorkerClient(initialization, {
    ...options,
    reportInitializationFailure,
    onSaveDelayChanged: (delayed) => policy.writerDelayChanged(delayed, generation),
    onAcknowledged: () => policy.recordSaved(),
    onRejected: (error, command) => {
      // A refused save (full storage, a held lock, a rolled-back I/O error) leaves those changes unsaved.
      if (!isProfileStateSaveCommand(command)) {
        return
      }
      // Another process moved the profile on, or the database can never open again, so no retry can save these changes.
      if (isProfileStateRevisionConflict(error) || isPermanentProfileStateOpenFailure(error)) {
        policy.reportStopped(error)
      } else {
        policy.recordSaveRefused(error)
      }
    },
    onFailure: (error, command) => {
      if (profileStateWriterFailureOutcome(error) === 'indeterminate') {
        // A crash during an export or other read refused no save, so recovery stays quiet.
        onIndeterminateFailure(
          writer,
          error,
          command !== undefined && isProfileStateSaveCommand(command)
        )
      } else {
        // A maintenance resume refused by the revision fence reports the write it was recovering from.
        policy.reportStopped(error)
      }
    }
  })
  return writer
}

/** Retires the faulted writer for a reopen, or reports saving stopped when recovery is not possible. */
export function closeIndeterminateProfileStateWriter(
  writer: ProfileStateWriteWorkerClient,
  canClose: () => boolean,
  retire: (revision: number) => boolean,
  reportStopped: () => void
): Promise<void> | undefined {
  if (!canClose()) {
    reportStopped()
    return undefined
  }
  const revision = writer.lastAcknowledgedRevision
  return writer
    .close()
    .catch(() => {})
    .then(() => {
      if (!retire(revision)) {
        reportStopped()
      }
    })
}
