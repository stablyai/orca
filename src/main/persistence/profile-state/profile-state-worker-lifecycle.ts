import { ProfileStateWriterError } from './profile-state-writer-errors'

export type ProfileStateWorkerAuthorityOptions = {
  workerPath?: string
  backupWorkerPath?: string
  onFailure?: (error: Error) => void
  onSaveDelayChanged?: (delayed: boolean) => void
  /** Close the writer thread after this long without a command; the next one reopens it (~22 ms). */
  writerIdleStopMs?: number
}

export function closedWriterError(): ProfileStateWriterError {
  return new ProfileStateWriterError(
    'profile-state-writer-closed',
    'Profile state writer is closing',
    'known-failure'
  )
}
