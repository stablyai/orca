import { buildDurableCheckpointSnapshot } from './daemon-durable-history-snapshot'
import { DaemonPtyCheckpointScheduler } from './daemon-pty-checkpoint-scheduler'
import type { SnapshotCheckpointResult } from './daemon-pty-runtime-state'
import type { GetSnapshotResult, TakePendingOutputResult } from './types'

export abstract class DaemonPtyCheckpointPersistence extends DaemonPtyCheckpointScheduler {
  // Why 'deferred' exists: a full snapshot inside the cooldown is postponed and the session stays dirty for retry;
  // skipping append meanwhile keeps the on-disk log a consistent (stale) prefix instead of punching a hole.
  protected async writeSessionCheckpoint(
    sessionId: string,
    opts: { final: boolean; teardown: boolean }
  ): Promise<'done' | 'deferred'> {
    if (!this.supportsIncrementalCheckpoints) {
      const result = await this.client.request<GetSnapshotResult>('getSnapshot', { sessionId })
      if (result.snapshot && this.historyManager) {
        const checkpoint = await this.historyManager.checkpoint(sessionId, result.snapshot)
        return checkpoint === 'retryable' ? 'deferred' : 'done'
      }
      return 'done'
    }
    if (opts.final || this.sessionsNeedingFullCheckpoint.has(sessionId)) {
      if (!opts.final && this.isFullCheckpointCoolingDown(sessionId)) {
        return 'deferred'
      }
      // Why take-with-snapshot not plain getSnapshot: it clears pending records in the same turn as the serialize,
      // so a warm reattach won't re-append records the checkpoint already contains (double-replay on cold restore).
      const checkpoint = await this.takeSnapshotAndCheckpoint(sessionId, {
        teardown: opts.teardown,
        forceLiveSnapshot: this.sessionsNeedingLiveCheckpoint.has(sessionId),
        requireContinuityProof: this.sessionsNeedingContinuityCheckpoint.has(sessionId)
      })
      if (checkpoint.checkpoint === 'retryable') {
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        return 'deferred'
      }
      this.sessionsNeedingFullCheckpoint.delete(sessionId)
      this.sessionsNeedingLiveCheckpoint.delete(sessionId)
      this.sessionsNeedingContinuityCheckpoint.delete(sessionId)
      return 'done'
    }
    const take = await this.client.request<TakePendingOutputResult | null>('takePendingOutput', {
      sessionId
    })
    if (!take) {
      return 'done'
    }
    if (take.overflowed) {
      // Why: overflow dropped records (log has a hole); only a full snapshot can re-anchor it.
      if (this.isFullCheckpointCoolingDown(sessionId)) {
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        return 'deferred'
      }
      const checkpoint = await this.takeSnapshotAndCheckpoint(sessionId, {
        teardown: false,
        forceLiveSnapshot: true
      })
      if (checkpoint.checkpoint === 'retryable') {
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        return 'deferred'
      }
      return 'done'
    }
    if (take.records.length === 0) {
      return 'done'
    }
    if (!this.historyManager) {
      return 'done'
    }
    const appendResult = await this.historyManager.appendIncrements(
      sessionId,
      take.seq,
      take.records
    )
    if (appendResult === 'needs-checkpoint') {
      // Why dropping take.records is lossless: applied to the emulator before the take, so the snapshot below contains them.
      if (this.isFullCheckpointCoolingDown(sessionId)) {
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        return 'deferred'
      }
      const checkpoint = await this.takeSnapshotAndCheckpoint(sessionId, {
        teardown: false,
        forceLiveSnapshot: true
      })
      if (checkpoint.checkpoint === 'retryable') {
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        return 'deferred'
      }
    }
    return 'done'
  }

  protected async takeSnapshotAndCheckpoint(
    sessionId: string,
    opts: {
      teardown: boolean
      forceLiveSnapshot?: boolean
      requireContinuityProof?: boolean
    }
  ): Promise<SnapshotCheckpointResult> {
    const take = await this.client.request<TakePendingOutputResult | null>('takePendingOutput', {
      sessionId,
      includeSnapshot: true,
      teardownSnapshot: opts.teardown
    })
    if (take?.snapshot && this.historyManager) {
      // Why require drainedRecords: an older daemon still empties the pending
      // queue on includeSnapshot but omits the field. Treating absence as []
      // would compact stale disk history and reset the log.
      const snapshot =
        take.drainedRecords === undefined || opts.forceLiveSnapshot === true || take.overflowed
          ? take.snapshot
          : await this.buildDurableHistorySnapshot(
              sessionId,
              take.snapshot,
              [...take.drainedRecords, ...take.records],
              {
                pendingRecordsAreComplete: take.seq === 1,
                ...(opts.requireContinuityProof === true
                  ? { requiredPreviousPendingOutputSeq: take.seq - 1 }
                  : {})
              }
            )
      const checkpoint = await this.historyManager.checkpoint(sessionId, snapshot, {
        pendingOutputSeq: take.seq
      })
      if (checkpoint === 'retryable') {
        // Why take.records is dropped, not appended: the pending output this take drained went into the snapshot that
        // failed to land, so appending the held tail at the next contiguous seq would splice it over that hole and
        // defeat the log's seq-gap detection. A stale prefix beats an undetectable hole.
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        this.sessionsNeedingLiveCheckpoint.add(sessionId)
        this.sessionsNeedingContinuityCheckpoint.delete(sessionId)
        this.markSessionDirty(sessionId)
        return { checkpoint, snapshot: take.snapshot }
      }
      if (checkpoint === 'unavailable') {
        this.sessionsNeedingFullCheckpoint.delete(sessionId)
        this.sessionsNeedingLiveCheckpoint.delete(sessionId)
        this.sessionsNeedingContinuityCheckpoint.delete(sessionId)
        return { checkpoint, snapshot: take.snapshot }
      }
      this.lastFullCheckpointAt.set(sessionId, Date.now())
      if (take.records.length > 0 && snapshot === take.snapshot) {
        // Why: live-window fallback still lacks held parser-state bytes; keep them as a post-checkpoint log tail.
        await this.historyManager.appendIncrements(sessionId, take.seq, take.records)
      }
      this.sessionsNeedingLiveCheckpoint.delete(sessionId)
      this.sessionsNeedingContinuityCheckpoint.delete(sessionId)
      return { checkpoint: 'committed', snapshot }
    }
    this.sessionsNeedingFullCheckpoint.delete(sessionId)
    this.sessionsNeedingLiveCheckpoint.delete(sessionId)
    this.sessionsNeedingContinuityCheckpoint.delete(sessionId)
    return { checkpoint: 'unavailable', snapshot: take?.snapshot ?? null }
  }

  protected async buildDurableHistorySnapshot(
    sessionId: string,
    liveSnapshot: NonNullable<TakePendingOutputResult['snapshot']>,
    pendingRecords: TakePendingOutputResult['records'],
    opts: {
      pendingRecordsAreComplete: boolean
      requiredPreviousPendingOutputSeq?: number
    }
  ): Promise<NonNullable<TakePendingOutputResult['snapshot']>> {
    if (!this.historyReader) {
      return liveSnapshot
    }
    try {
      const restoreInfo = await this.historyReader.detectColdRestore(sessionId, {
        ignoreCleanEnd: true,
        wslDistro: this.wslDistrosBySessionId.get(sessionId)
      })
      if (
        (!restoreInfo && !opts.pendingRecordsAreComplete) ||
        (opts.requiredPreviousPendingOutputSeq !== undefined &&
          restoreInfo?.pendingOutputSeq !== opts.requiredPreviousPendingOutputSeq)
      ) {
        console.warn('[history] durable continuity unproven; using live snapshot:', sessionId)
        return liveSnapshot
      }
      return await buildDurableCheckpointSnapshot({
        liveSnapshot,
        restoreInfo,
        pendingRecords
      })
    } catch (error) {
      console.warn('[history] durable history rebuild failed:', sessionId, error)
      return liveSnapshot
    }
  }
}
