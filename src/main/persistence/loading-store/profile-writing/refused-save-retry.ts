import type { StoreRuntimeState } from '../store-runtime-state'
import { enqueueWrite, type PrimaryStateWriteOperations } from './primary-state-writes'
import {
  ProfileStateWriterError,
  profileStateWriterFailureOutcome
} from '../../profile-state/writer/profile-state-writer-errors'
import { ProfileStateDatabaseOpenError } from '../../profile-state/database/profile-state-database-errors'
import { isProfileStateRevisionConflict } from '../../profile-state/writer/profile-state-writer-reopen-policy'

const SAVE_RETRY_MS = 5_000
const MAX_SAVE_RETRY_MS = 60_000

type SaveRetryRuntime = Pick<
  StoreRuntimeState,
  | 'firstPendingSaveAt'
  | 'profileMaintenancePending'
  | 'profileStateAuthority'
  | 'quitFlushStarted'
  | 'writeTimer'
  | 'writesFrozen'
>

/** The save timer's job; a refused save is tried again instead of waiting for the next edit. */
export function runScheduledSave(
  runtime: SaveRetryRuntime,
  writes: PrimaryStateWriteOperations,
  retryDelayMs = SAVE_RETRY_MS
): void {
  runtime.writeTimer = null
  runtime.firstPendingSaveAt = null
  void enqueueWrite(writes, { skipIfClean: true }).catch((error: unknown) =>
    retryRefusedSave(runtime, writes, error, retryDelayMs)
  )
}

/** Backs off to once a minute; a new edit re-arms the normal save timer, which restarts it. */
export function retryRefusedSave(
  runtime: SaveRetryRuntime,
  writes: PrimaryStateWriteOperations,
  error: unknown,
  delayMs = SAVE_RETRY_MS
): void {
  if (retryBlocked(runtime) || !savingCanResume(runtime, error)) {
    return
  }
  const nextDelayMs = Math.min(delayMs * 2, MAX_SAVE_RETRY_MS)
  runtime.writeTimer = setTimeout(() => runScheduledSave(runtime, writes, nextDelayMs), delayMs)
}

/** A flush cancelled before its write ran cleared the save timer; put a save back so its changes are not stranded. */
export function rescheduleCancelledSave(
  runtime: SaveRetryRuntime,
  writes: PrimaryStateWriteOperations
): void {
  if (retryBlocked(runtime) || savingStopped(runtime)) {
    return
  }
  runtime.writeTimer = setTimeout(() => runScheduledSave(runtime, writes), SAVE_RETRY_MS)
}

function retryBlocked(runtime: SaveRetryRuntime): boolean {
  return Boolean(
    runtime.writeTimer ||
    runtime.writesFrozen ||
    runtime.quitFlushStarted ||
    runtime.profileMaintenancePending
  )
}

/** Only a save the writer refused, or a reopen it could not finish, can succeed later; a conflict or a writer stopped for good never will. */
function savingCanResume(runtime: SaveRetryRuntime, error: unknown): boolean {
  const refusedByWriter =
    error instanceof ProfileStateWriterError ||
    // Another profile's database, or a bad profile id, will not open on a later try either.
    (error instanceof ProfileStateDatabaseOpenError && error.code === 'unreadable') ||
    profileStateWriterFailureOutcome(error) === 'indeterminate'
  if (!refusedByWriter || isProfileStateRevisionConflict(error)) {
    return false
  }
  return !savingStopped(runtime)
}

// A faulted writer fails assertWritable while it retires, yet the next save reopens it; only a real stop counts.
function savingStopped(runtime: SaveRetryRuntime): boolean {
  const authority = runtime.profileStateAuthority
  return Boolean(authority && 'savingStopped' in authority && authority.savingStopped)
}
