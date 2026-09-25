import { awaitDaemonWorkWithinCallerDeadline } from './daemon-request-deadline'
import { DaemonPtyConnectionLifecycle } from './daemon-pty-connection-lifecycle'

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
    // Why: dirty-gate the timer — a permanent 5s interval woke the main process for idle terminals with nothing to write.
    this.checkpointTimer = setTimeout(
      () => {
        this.checkpointTimer = null
        // Why: don't overlap checkpoint passes — concurrent tmp-file writes can lose a rename and disable future history writes.
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
          // Why: .finally() re-throws, so a rejected checkpoint would surface as an unhandled rejection here.
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
    // Why: dirty-version filtering avoids re-serializing every idle session every 5s (CPU/disk on large workspaces)
    // while not dropping writes that arrive mid-checkpoint.
    const versions = new Map(
      [...this.dirtySessionVersions].filter(([sessionId]) => this.activeSessionIds.has(sessionId))
    )
    if (versions.size === 0) {
      this.dirtySessionVersions.clear()
      this.stopCheckpointTimer()
      return
    }
    const completed = await this.checkpointSessions(versions.keys())
    for (const [sessionId, version] of versions) {
      if (completed.has(sessionId) && this.dirtySessionVersions.get(sessionId) === version) {
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
    // Why: a promise tail keeps every waiter ordered; awaiting one active operation lets sibling waiters resume together.
    const previous = this.checkpointInFlight ?? Promise.resolve()
    const checkpoint = previous.catch(() => {}).then(operation)
    this.checkpointInFlight = checkpoint
    // Why the release rides the checkpoint instead of the caller's await: a caller that walks away
    // at its deadline must leave this checkpoint as the tail, so the durable write still runs to
    // completion, still commits, and the next waiter still queues behind it (STA-4228).
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

  // Why final=true not teardown: clean disconnect needs the full daemon-window snapshot as the restore source, but the
  // detached daemon's PTYs keep running for warm reattach, so shell-ready scanner state must stay intact.
  protected async checkpointAllSessions(): Promise<void> {
    const completed = await this.checkpointSessions(this.activeSessionIds, { final: true })
    for (const sessionId of completed) {
      this.dirtySessionVersions.delete(sessionId)
    }
  }

  protected async checkpointSessions(
    sessionIds: Iterable<string>,
    opts?: { final?: boolean; teardown?: boolean }
  ): Promise<Set<string>> {
    const completed = new Set<string>()
    if (!this.historyManager) {
      return completed
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
            // Why: deferred sessions stay dirty so the checkpoint timer keeps retrying until their full-snapshot cooldown expires.
            if (result === 'done') {
              completed.add(sessionId)
            }
          })
          .catch((err) => console.warn('[history] checkpoint failed:', sessionId, err))
      }
    }
    // Why: snapshot/checkpoint writes are CPU/disk heavy; cap prevents one tick snapshotting every dirty terminal at once.
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
    return completed
  }

  // Why cooldown starts only after the first full snapshot: a checkpoint-less session must be able to write one immediately.
  protected isFullCheckpointCoolingDown(sessionId: string): boolean {
    const last = this.lastFullCheckpointAt.get(sessionId)
    if (last === undefined) {
      return false
    }
    const elapsed = Date.now() - last
    // Why elapsed < 0 counts as expired: a backward wall-clock jump must not extend the deferral window.
    return (
      elapsed >= 0 &&
      elapsed <
        (this.constructor as typeof DaemonPtyCheckpointScheduler).FULL_CHECKPOINT_COOLDOWN_MS
    )
  }

  protected async checkpointSession(
    sessionId: string,
    opts: { final: boolean; teardown: boolean }
  ): Promise<'done' | 'deferred'> {
    // Why final waits without a deadline: sleep/disconnect needs the last snapshot on disk, and
    // deferring there would silently drop what the user left on screen rather than delay it.
    if (opts.final) {
      return await this.checkpointQueue.run(sessionId, () =>
        this.writeSessionCheckpoint(sessionId, opts)
      )
    }
    // Why 'deferred' is safe: the session stays dirty, so the operation that beat us to the queue
    // still commits and the next tick retries this one. Nothing on disk is discarded.
    if (
      this.checkpointQueue.isSaturated(sessionId) ||
      !this.tryAdmitNonFinalCheckpoint(sessionId)
    ) {
      return 'deferred'
    }
    const run = async (): Promise<'done' | 'deferred'> => {
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
