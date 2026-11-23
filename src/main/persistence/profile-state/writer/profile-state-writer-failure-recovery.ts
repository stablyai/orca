import type { ProfileStateWriterInitialization } from './profile-state-writer-protocol'
import { profileStateWriterFailureOutcome } from './profile-state-writer-errors'
import { ProfileStateWriteWorkerClient } from './profile-state-writer-worker-client'
import type { ProfileStateWorkerAuthorityOptions } from '../profile-state-worker-authority'

export function createProfileStateWriter(
  initialization: ProfileStateWriterInitialization,
  options: ProfileStateWorkerAuthorityOptions,
  reportInitializationFailure: boolean,
  onIndeterminateFailure: (writer: ProfileStateWriteWorkerClient, error: Error) => void
): ProfileStateWriteWorkerClient {
  let writer: ProfileStateWriteWorkerClient
  writer = new ProfileStateWriteWorkerClient(initialization, {
    ...options,
    reportInitializationFailure,
    onFailure: (error) => {
      if (profileStateWriterFailureOutcome(error) === 'indeterminate') {
        onIndeterminateFailure(writer, error)
      } else {
        options.onFailure?.(error)
      }
    }
  })
  return writer
}

export function closeIndeterminateProfileStateWriter(
  writer: ProfileStateWriteWorkerClient,
  canClose: () => boolean,
  onClosed: (revision: number) => void
): Promise<void> | undefined {
  if (!canClose()) {
    return undefined
  }
  const revision = writer.lastAcknowledgedRevision
  return writer
    .close()
    .catch(() => {})
    .then(() => onClosed(revision))
}
