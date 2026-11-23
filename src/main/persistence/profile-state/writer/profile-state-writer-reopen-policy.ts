import type { ProfileStateSaveNotice } from '../../../../shared/orca-profiles/profile-state-save-notice'
import { storageCapacityErrorCode } from '../../../../shared/errors/storage-capacity-error'
import {
  isDamagedProfileStateDatabase,
  ProfileStateDatabaseOpenError
} from '../database/profile-state-database-errors'
import { ProfileStateDocumentCorruptionError } from '../documents/profile-state-document-validation'

const REOPEN_LOG_INTERVAL_MS = 10 * 60_000
const MAX_REOPEN_BACKOFF_MS = 60_000

/** Counts writer reopens, spaces out retries after a failed one, and keeps the save notice up while recovering. */
export class ProfileStateWriterReopenPolicy {
  private reopens = 0
  private lastLogMs: number | undefined
  private failure: { error: unknown; failures: number; retryAtMs: number } | undefined
  private bypassOnce = false
  private interrupted: Error | undefined
  private recovering = false
  private diskFull = false
  private writerDelayed = false
  private noticeShown: ProfileStateSaveNotice = null
  private stopReported = false
  private writerGeneration = 0

  constructor(
    private readonly callbacks: () => {
      onFailure?: (error: Error) => void
      onSaveDelayChanged?: (notice: ProfileStateSaveNotice) => void
    } = () => ({}),
    private readonly now: () => number = Date.now
  ) {}

  get count(): number {
    return this.reopens
  }

  /** Throws the last failure while its backoff lasts; nothing is spawned meanwhile. */
  admit(): void {
    if (this.bypassOnce) {
      this.bypassOnce = false
      return
    }
    if (this.failure && this.now() < this.failure.retryAtMs) {
      throw this.failure.error
    }
  }

  /** A final or maintenance flush gets one attempt even inside a backoff. */
  bypassBackoffOnce(): void {
    this.bypassOnce = this.failure !== undefined
  }

  /** Writes just over the idle window apart churn the thread; one line per window keeps that visible. */
  recordAttempt(): void {
    this.reopens += 1
    const now = this.now()
    if (this.lastLogMs !== undefined && now - this.lastLogMs < REOPEN_LOG_INTERVAL_MS) {
      return
    }
    this.lastLogMs = now
    console.info(`[persistence] Reopened the profile writer (${this.reopens} reopens so far)`)
  }

  /** The interrupted write a reopen recovers from; a refused reopen reports it, not its revision conflict. */
  recoverFrom(error: Error, save = true): void {
    if (!save) {
      return
    }
    this.interrupted = error
    this.raiseUnsaved('A profile save was interrupted', error)
  }

  /** A save could not run because the writer failed to reopen; an export failing the same way refused no save. */
  recordReopenRefused(error: unknown, save: boolean): void {
    if (save && !this.stopReported) {
      this.raiseUnsaved(
        'Could not reopen the profile writer',
        error instanceof Error ? error : new Error(String(error))
      )
    }
  }

  /** Storage refused a save and rolled it back; the warning stays up until it acknowledges a later command. */
  recordSaveRefused(error: Error): void {
    this.raiseUnsaved('A profile save was refused', error)
  }

  private raiseUnsaved(reason: string, error: Error): void {
    if (!this.recovering) {
      console.warn(`[persistence] ${reason}; retrying:`, error)
    }
    // Only this failure's own error says the disk is full; a later failure may have another cause.
    this.diskFull = storageCapacityErrorCode(error) !== null
    this.recovering = true
    this.publishNotice()
  }

  private endRecovery(): void {
    this.recovering = false
    this.diskFull = false
    this.publishNotice()
  }

  /** A failure streak is under way; the unsaved warning is up until a save lands. */
  get refusingSaves(): boolean {
    return this.recovering
  }

  get savingStopped(): boolean {
    return this.stopReported
  }

  /** Saving stopped for good. A revision conflict after an interrupted write reports that write instead. */
  reportStopped(error: unknown): void {
    this.endRecovery()
    // A conflicted writer stays open, so every later save is refused again; tell the user once.
    if (this.stopReported) {
      return
    }
    this.stopReported = true
    const cause =
      this.interrupted && isProfileStateRevisionConflict(error) ? this.interrupted : error
    reportTerminalReopenFailure(this.callbacks().onFailure, cause)
  }

  /** A slow writer command raises the same notice that recovery keeps up until a save lands. */
  writerDelayChanged(delayed: boolean, generation: number): void {
    // A retired writer's late signal must not clear or raise its replacement's slow notice.
    if (generation !== this.writerGeneration) {
      return
    }
    this.writerDelayed = delayed
    // A faulting command clears its delay just before recovery starts; publish after recovery claims the notice.
    queueMicrotask(() => this.publishNotice())
  }

  /** Each new writer replaces the last, whose slow command no longer counts. */
  beginWriter(): number {
    this.writerDelayed = false
    return ++this.writerGeneration
  }

  /** Storage acknowledged a command, so saving works again. */
  recordSaved(): void {
    // The acknowledged command is no longer slow; its own clear arrives a microtask later.
    this.writerDelayed = false
    this.interrupted = undefined
    this.stopReported = false
    if (this.recovering) {
      this.endRecovery()
    }
  }

  private publishNotice(): void {
    const notice: ProfileStateSaveNotice = this.recovering
      ? this.diskFull
        ? 'disk-full'
        : 'failing'
      : this.writerDelayed
        ? 'slow'
        : null
    if (notice === this.noticeShown) {
      return
    }
    this.noticeShown = notice
    try {
      this.callbacks().onSaveDelayChanged?.(notice)
    } catch (error) {
      console.error('[persistence] Could not report delayed saving:', error)
    }
  }

  recordSuccess(): void {
    this.failure = undefined
    this.interrupted = undefined
    this.stopReported = false
    // A bypass granted during a backoff must not carry over to a later, unrelated one.
    this.bypassOnce = false
  }

  /** Logs and returns the delay before a retry, or null when the failure is terminal (a revision conflict). */
  recordFailure(error: unknown): { retryInMs: number } | null {
    if (isProfileStateRevisionConflict(error) || isPermanentProfileStateOpenFailure(error)) {
      return null
    }
    const failures = (this.failure?.failures ?? 0) + 1
    // The first retry is immediate; repeated failures back off up to a minute.
    const retryInMs =
      failures === 1 ? 0 : Math.min(1_000 * 2 ** (failures - 2), MAX_REOPEN_BACKOFF_MS)
    this.failure = { error, failures, retryAtMs: this.now() + retryInMs }
    console.warn(
      `[persistence] Could not reopen the profile writer; retrying in ${retryInMs} ms:`,
      error
    )
    return { retryInMs }
  }
}

/** A throwing listener must not replace the conflict the caller is about to see. */
export function reportTerminalReopenFailure(
  onFailure: ((error: Error) => void) | undefined,
  error: unknown
): void {
  try {
    onFailure?.(error instanceof Error ? error : new Error(String(error)))
  } catch (notificationError) {
    console.error('[persistence] Could not report stopped saving:', notificationError)
  }
}

export function isProfileStateRevisionConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'profile-state-revision-conflict'
  )
}

/** Another profile's database, a newer schema, a bad profile id, a damaged database or a corrupt document will not open on a later try. */
export function isPermanentProfileStateOpenFailure(error: unknown): boolean {
  if (error instanceof ProfileStateDatabaseOpenError) {
    // An unreadable database may only be locked or on a full disk; only damage is permanent.
    return error.code !== 'unreadable' || isDamagedProfileStateDatabase(error)
  }
  return error instanceof ProfileStateDocumentCorruptionError
}
