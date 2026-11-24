import { awaitDaemonWorkWithinCallerDeadline } from '../../launch/daemon-request-deadline'
import { NdjsonLineTooLongError } from '../../../../shared/json-stream/main-process-ndjson-framer'
import { DaemonPtyConnectionLifecycle } from '../adapter/daemon-pty-connection-lifecycle'
import {
  FinalCheckpointNotCommittedError,
  assertDegradedRestoreAvailable
} from '../adapter/daemon-pty-lifecycle-errors'
import type { ColdRestoreDetection } from '../../history/restoration/terminal-history-cold-restore-info'
import type {
  CheckpointWriteResult,
  SettledCheckpointOutcome
} from './daemon-pty-checkpoint-result'

// Exponential backoff after a failed full checkpoint; the final step is the cap.
const FULL_CHECKPOINT_BACKOFF_STEPS_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const

export abstract class DaemonPtyCheckpointScheduler extends DaemonPtyConnectionLifecycle {
  protected stopCheckpointTimer(): void {
    if (!this.checkpointTimer) {
      return
    }
    clearTimeout(this.checkpointTimer)
    this.checkpointTimer = null
  }

  protected stopCheckpointTimerIfIdle(): void {
    if (this.dirtySessionVersions.size === 0) {
      this.stopCheckpointTimer()
    }
  }

  protected scheduleCheckpointTimer(): void {
    if (
      this.checkpointTimer ||
      !this.historyManager ||
      !this.supportsCheckpoints ||
      this.dirtySessionVersions.size === 0
    ) {
      return
    }
    // Dirty-gate timers so idle terminals do not wake the main process.
    this.checkpointTimer = setTimeout(
      () => {
        this.checkpointTimer = null
        // Serialize checkpoint passes: concurrent temporary-file renames can disable history writes.
        if (this.checkpointInFlight) {
          this.scheduleCheckpointTimer()
          return
        }
        const checkpoint = this.checkpointDirtySessions()
        this.checkpointInFlight = checkpoint
        void checkpoint
          .finally(() => {
            if (this.checkpointInFlight === checkpoint) {
              this.checkpointInFlight = null
              this.scheduleCheckpointTimer()
            }
          })
          // finally preserves rejection; handle it on this unawaited timer task.
          .catch(() => {})
      },
      (this.constructor as typeof DaemonPtyCheckpointScheduler).CHECKPOINT_INTERVAL_MS
    )
  }

  protected markSessionDirty(sessionId: string): void {
    if (!this.activeSessionIds.has(sessionId)) {
      return
    }
    this.dirtySessionVersions.set(sessionId, (this.dirtySessionVersions.get(sessionId) ?? 0) + 1)
    this.scheduleCheckpointTimer()
  }

  protected async checkpointDirtySessions(): Promise<void> {
    if (!this.historyManager || this.dirtySessionVersions.size === 0) {
      return
    }
    // Track versions so idle sessions stay cheap and writes arriving mid-checkpoint remain dirty.
    const versions = new Map(
      [...this.dirtySessionVersions].filter(([sessionId]) => this.activeSessionIds.has(sessionId))
    )
    if (versions.size === 0) {
      this.dirtySessionVersions.clear()
      this.stopCheckpointTimer()
      return
    }
    const { settled } = await this.checkpointSessions(versions.keys())
    for (const [sessionId, version] of versions) {
      // Settled passes (including permanent loss / no snapshot) must stop polling;
      // only deferred passes stay dirty for a later retry (#46691 rev2 regression).
      if (settled.has(sessionId) && this.dirtySessionVersions.get(sessionId) === version) {
        this.dirtySessionVersions.delete(sessionId)
      }
    }
    this.stopCheckpointTimerIfIdle()
  }

  /** False only when `callerDeadlineMs` expired first; the checkpoint itself keeps running. */
  protected async runExclusiveCheckpoint(
    operation: () => Promise<void>,
    options: { rescheduleDirty?: boolean; callerDeadlineMs?: number } = {}
  ): Promise<boolean> {
    this.stopCheckpointTimer()
    // Chain every waiter; awaiting only the active operation would release siblings together.
    const previous = this.checkpointInFlight ?? Promise.resolve()
    const checkpoint = previous.catch(() => {}).then(operation)
    this.checkpointInFlight = checkpoint
    // Release on checkpoint settlement, not caller timeout, so durable writes finish and later waiters stay ordered.
    const settled = checkpoint.then(
      () => this.releaseExclusiveCheckpoint(checkpoint, options.rescheduleDirty),
      (err: unknown) => {
        this.releaseExclusiveCheckpoint(checkpoint, options.rescheduleDirty)
        throw err
      }
    )
    if (options.callerDeadlineMs === undefined) {
      await settled
      return true
    }
    return await awaitDaemonWorkWithinCallerDeadline(settled, options.callerDeadlineMs)
  }

  protected releaseExclusiveCheckpoint(
    checkpoint: Promise<void>,
    rescheduleDirty: boolean | undefined
  ): void {
    if (this.checkpointInFlight === checkpoint) {
      this.checkpointInFlight = null
    }
    this.stopCheckpointTimer()
    if (rescheduleDirty !== false) {
      this.scheduleCheckpointTimer()
    }
  }

  // Final disconnect snapshots preserve scanner state because daemon PTYs remain alive for reattach.
  protected async checkpointAllSessions(): Promise<void> {
    const { settled } = await this.checkpointSessions(this.activeSessionIds, { final: true })
    for (const sessionId of settled.keys()) {
      this.dirtySessionVersions.delete(sessionId)
    }
  }

  protected async checkpointSessions(
    sessionIds: Iterable<string>,
    opts?: { final?: boolean; teardown?: boolean }
  ): Promise<{
    settled: Map<string, SettledCheckpointOutcome>
    errors: Map<string, unknown>
  }> {
    const settled = new Map<string, SettledCheckpointOutcome>()
    const errors = new Map<string, unknown>()
    if (!this.historyManager) {
      return { settled, errors }
    }
    const ids = Array.from(sessionIds)
    let nextIndex = 0

    const checkpointNext = async (): Promise<void> => {
      for (;;) {
        // No worker in this pass awaits abandoned work, so a full admission set cannot open here.
        if (
          opts?.final !== true &&
          this.nonFinalCheckpointAdmissionSessionIds.size >=
            (this.constructor as typeof DaemonPtyCheckpointScheduler).MAX_CONCURRENT_CHECKPOINTS
        ) {
          const deferredSessionId = ids[nextIndex]
          if (deferredSessionId !== undefined) {
            this.reportNonFinalGlobalAdmissionDenial(deferredSessionId)
          }
          return
        }
        const index = nextIndex
        nextIndex++
        if (index >= ids.length) {
          return
        }
        const sessionId = ids[index]
        await this.checkpointSession(sessionId, {
          final: opts?.final === true,
          teardown: opts?.teardown === true
        })
          .then((result) => {
            // Deferred sessions stay dirty for later checkpoint retries.
            if (result !== 'deferred') {
              settled.set(sessionId, result)
            }
          })
          .catch((err) => {
            errors.set(sessionId, err)
            console.warn('[history] checkpoint failed:', sessionId, err)
          })
      }
    }
    // Limit simultaneous CPU and disk work across dirty terminals.
    const workers = Array.from(
      {
        length: Math.min(
          (this.constructor as typeof DaemonPtyCheckpointScheduler).MAX_CONCURRENT_CHECKPOINTS,
          ids.length
        )
      },
      () => checkpointNext()
    )
    await Promise.all(workers)
    return { settled, errors }
  }

  // A session without a checkpoint must write its first snapshot immediately.
  protected isFullCheckpointCoolingDown(sessionId: string): boolean {
    const last = this.lastFullCheckpointAt.get(sessionId)
    if (last === undefined) {
      return false
    }
    const elapsed = Date.now() - last
    // A backward clock jump must not extend cooldown.
    return (
      elapsed >= 0 &&
      elapsed <
        (this.constructor as typeof DaemonPtyCheckpointScheduler).FULL_CHECKPOINT_COOLDOWN_MS
    )
  }

  /** True while a failed full checkpoint is inside its exponential backoff window. */
  protected isFullCheckpointBackingOff(sessionId: string): boolean {
    const backoff = this.fullCheckpointBackoff.get(sessionId)
    if (backoff === undefined) {
      return false
    }
    const step =
      FULL_CHECKPOINT_BACKOFF_STEPS_MS[
        Math.min(backoff.streak - 1, FULL_CHECKPOINT_BACKOFF_STEPS_MS.length - 1)
      ]
    const elapsed = Date.now() - backoff.failedAt
    // A backward clock jump must not extend backoff.
    return elapsed >= 0 && elapsed < step
  }

  protected recordFullCheckpointFailure(sessionId: string): void {
    const previous = this.fullCheckpointBackoff.get(sessionId)
    this.fullCheckpointBackoff.set(sessionId, {
      failedAt: Date.now(),
      streak: (previous?.streak ?? 0) + 1
    })
  }

  protected clearFullCheckpointBackoff(sessionId: string): void {
    this.fullCheckpointBackoff.delete(sessionId)
  }

  /**
   * Sleep may retire a terminal without a committed final checkpoint only when no
   * retry can fix the loss; otherwise the live terminal must be preserved.
   */
  protected evaluateFinalCheckpointPreservation(
    sessionId: string,
    outcome: SettledCheckpointOutcome | undefined,
    error: unknown
  ): { degraded: boolean; outcome: SettledCheckpointOutcome | undefined } {
    if (outcome === 'committed') {
      return { degraded: false, outcome }
    }
    const permanentLoss =
      !this.historyManager ||
      outcome === 'permanently-unavailable' ||
      outcome === 'no-snapshot' ||
      error instanceof NdjsonLineTooLongError
    if (!permanentLoss) {
      // A failed Sleep must not leave a heavy full-snapshot retry running every interval.
      this.sessionsNeedingFullCheckpoint.delete(sessionId)
      this.sessionsNeedingLiveCheckpoint.delete(sessionId)
      this.sessionsNeedingContinuityCheckpoint.delete(sessionId)
      throw new FinalCheckpointNotCommittedError(sessionId)
    }
    console.warn('[history] sleep proceeds on the last committed checkpoint (degraded):', {
      sessionId,
      outcome: outcome ?? 'deferred',
      error: error instanceof Error ? error.message : error,
      degraded: true
    })
    return { degraded: true, outcome }
  }

  /**
   * Sleep's recovery evidence: evaluate the final pass, then require a woken-from
   * checkpoint before a degraded kill. Returns what the caller also needs for the
   * cold-restore cache (wsl distro + detection).
   */
  protected async sleepRecoveryEvidence(
    sessionId: string,
    outcome: SettledCheckpointOutcome | undefined,
    error: unknown
  ): Promise<{ wslDistro: string | undefined; detection: ColdRestoreDetection | undefined }> {
    const preservation = this.evaluateFinalCheckpointPreservation(sessionId, outcome, error)
    const wslDistro = this.wslDistrosBySessionId.get(sessionId)
    const detection = await this.historyReader?.detectColdRestoreState(sessionId, { wslDistro })
    const detected = detection?.status === 'restored' ? detection.restoreInfo : null
    assertDegradedRestoreAvailable(sessionId, preservation, detected)
    return { wslDistro, detection }
  }

  protected async checkpointSession(
    sessionId: string,
    opts: { final: boolean; teardown: boolean }
  ): Promise<CheckpointWriteResult> {
    // Final writes must persist the last screen; wait for queued compaction instead of deferring.
    if (opts.final) {
      return await this.checkpointQueue.run(sessionId, () =>
        this.writeSessionCheckpoint(sessionId, opts)
      )
    }
    // Deferral preserves dirty state and lets admitted writes commit before the next retry.
    if (
      this.checkpointQueue.isSaturated(sessionId) ||
      !this.tryAdmitNonFinalCheckpoint(sessionId)
    ) {
      return 'deferred'
    }
    const run = async (): Promise<CheckpointWriteResult> => {
      try {
        return await this.writeSessionCheckpoint(sessionId, opts)
      } finally {
        this.releaseNonFinalCheckpointAdmission(sessionId)
        this.periodicDeadlineWarnedSessionIds.delete(sessionId)
      }
    }
    return await this.checkpointQueue.runWithDeadline(
      sessionId,
      run,
      (this.constructor as typeof DaemonPtyCheckpointScheduler).PERIODIC_CHECKPOINT_DEADLINE_MS,
      'deferred',
      {
        onDeadline: () => {
          if (!this.periodicDeadlineWarnedSessionIds.has(sessionId)) {
            this.periodicDeadlineWarnedSessionIds.add(sessionId)
            console.warn('[history] periodic checkpoint deadline exceeded:', sessionId)
          }
        },
        onAbandonedRejection: (error) => {
          console.warn('[history] checkpoint failed:', sessionId, error)
        }
      }
    )
  }
}
