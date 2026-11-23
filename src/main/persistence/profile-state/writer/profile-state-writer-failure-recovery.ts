import { dirname } from 'node:path'
import type { ProfileStateWriterInitialization } from './profile-state-writer-protocol'
import { storageCapacityErrorCode } from '../../../../shared/errors/storage-capacity-error'
import { profileStateWriterFailureOutcome } from './profile-state-writer-errors'
import { ProfileStateWriteWorkerClient } from './profile-state-writer-worker-client'
import type { ProfileStateWorkerAuthorityOptions } from '../profile-state-worker-authority'
import type { ProfileStateWriterReopenPolicy } from './profile-state-writer-reopen-policy'

export function createProfileStateWriter(
  initialization: ProfileStateWriterInitialization,
  options: ProfileStateWorkerAuthorityOptions,
  reportInitializationFailure: boolean,
  policy: ProfileStateWriterReopenPolicy,
  onIndeterminateFailure: (writer: ProfileStateWriteWorkerClient, error: Error) => void
): ProfileStateWriteWorkerClient {
  policy.useStorageDirectory(dirname(initialization.databasePath))
  let writer: ProfileStateWriteWorkerClient
  writer = new ProfileStateWriteWorkerClient(initialization, {
    ...options,
    reportInitializationFailure,
    onSaveDelayChanged: policy.writerDelayChanged,
    onAcknowledged: () => policy.recordSaved(),
    onRejected: (error) => {
      // Full storage refuses every later save too, until space returns.
      if (storageCapacityErrorCode(error)) {
        policy.recordStorageRefused(error)
      }
    },
    onFailure: (error) => {
      if (profileStateWriterFailureOutcome(error) === 'indeterminate') {
        onIndeterminateFailure(writer, error)
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
