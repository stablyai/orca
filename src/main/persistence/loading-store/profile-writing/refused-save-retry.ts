import type { StoreRuntimeState } from '../store-runtime-state'
import { enqueueWrite, type PrimaryStateWriteOperations } from './primary-state-writes'
import {
  ProfileStateWriterError,
  profileStateWriterFailureOutcome
} from '../../profile-state/writer/profile-state-writer-errors'
import { ProfileStateDatabaseOpenError } from '../../profile-state/database/profile-state-database-errors'
import {
  isPermanentProfileStateOpenFailure,
  isProfileStateRevisionConflict
} from '../../profile-state/writer/profile-state-writer-reopen-policy'

const SAVE_RETRY_MS = 5_000
// Timed retries end after this one; no timer runs for the whole session while storage refuses.
const LAST_TIMED_RETRY_MS = 40_000

// Refused saves waiting for the next edit, window focus, wake from sleep or the quit flush.
const parkedSaves = new Map<SaveRetryRuntime, PrimaryStateWriteOperations>()

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
  retryDelayMs = SAVE_RETRY_MS,
  retrying = false
): void {
  runtime.writeTimer = null
  runtime.firstPendingSaveAt = null
  // A retry must reach the writer even with nothing dirty (a refused flush of clean state); its acknowledgement clears the warning.
  void enqueueWrite(writes, { skipIfClean: !retrying }).catch((error: unknown) =>
    retryRefusedSave(runtime, writes, error, retryDelayMs)
  )
}

/** Retries after 5, 10, 20 and 40 s, then waits for an event; a new edit re-arms the normal save timer. */
export function retryRefusedSave(
  runtime: SaveRetryRuntime,
  writes: PrimaryStateWriteOperations,
  error: unknown,
  delayMs = SAVE_RETRY_MS
): void {
  if (retryBlocked(runtime) || !savingCanResume(runtime, error)) {
    return
  }
  if (delayMs > LAST_TIMED_RETRY_MS) {
    parkedSaves.set(runtime, writes)
    return
  }
  runtime.writeTimer = setTimeout(
    () => runScheduledSave(runtime, writes, delayMs * 2, true),
    delayMs
  )
}

export function forgetParkedSave(runtime: SaveRetryRuntime): void {
  parkedSaves.delete(runtime)
}

/** The user is back (window focus, wake from sleep): try each save that ran out of timed retries. */
export function retryParkedSaves(): void {
  for (const [runtime, writes] of parkedSaves) {
    if (runtime.writesFrozen || runtime.quitFlushStarted || savingStopped(runtime)) {
      parkedSaves.delete(runtime)
    } else if (!retryBlocked(runtime)) {
      parkedSaves.delete(runtime)
      runScheduledSave(runtime, writes, LAST_TIMED_RETRY_MS * 2, true)
    }
  }
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
    error instanceof ProfileStateDatabaseOpenError ||
    profileStateWriterFailureOutcome(error) === 'indeterminate'
  if (
    !refusedByWriter ||
    isProfileStateRevisionConflict(error) ||
    isPermanentProfileStateOpenFailure(error)
  ) {
    return false
  }
  return !savingStopped(runtime)
}

// A faulted writer fails assertWritable while it retires, yet the next save reopens it; only a real stop counts.
function savingStopped(runtime: SaveRetryRuntime): boolean {
  const authority = runtime.profileStateAuthority
  return Boolean(authority && 'savingStopped' in authority && authority.savingStopped)
}
