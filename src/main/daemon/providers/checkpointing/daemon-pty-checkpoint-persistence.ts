import { buildDurableCheckpointSnapshot } from './daemon-durable-history-snapshot'
import {
  mapHistoryCheckpointResult,
  type CheckpointWriteResult
} from './daemon-pty-checkpoint-result'
import { DaemonPtyCheckpointScheduler } from './daemon-pty-checkpoint-scheduler'
import type { SnapshotCheckpointResult } from '../adapter/daemon-pty-runtime-state'
import type { HistoryCheckpointResult } from '../../history/storage/terminal-history-manager-options'
import type { GetSnapshotResult, TakePendingOutputResult } from '../../protocol/daemon-rpc-contract'

function settledCheckpointOutcome(result: SnapshotCheckpointResult): CheckpointWriteResult {
  switch (result.checkpoint) {
    case 'committed':
      return 'committed'
    case 'retryable':
      return 'deferred'
    case 'unavailable':
      return 'permanently-unavailable'
    case 'no-snapshot':
      return 'no-snapshot'
  }
}

export abstract class DaemonPtyCheckpointPersistence extends DaemonPtyCheckpointScheduler {
  // Defer without appending so cooldown preserves a consistent log prefix; keep the session dirty for retry.
  protected async writeSessionCheckpoint(
    sessionId: string,
    opts: { final: boolean; teardown: boolean }
  ): Promise<CheckpointWriteResult> {
    if (!this.supportsIncrementalCheckpoints) {
      // Protocol 4-12 daemons take the full getSnapshot path; apply the same
      // throttling contract so a retryable failure cannot storm every 5s.
      // Final requests (Sleep/quit) are never throttled: the last snapshot must run.
      if (!opts.final) {
        if (this.isFullCheckpointBackingOff(sessionId)) {
          return 'deferred'
        }
        if (this.isFullCheckpointCoolingDown(sessionId)) {
          return 'deferred'
        }
      }
      const result = await this.client.request<GetSnapshotResult>('getSnapshot', { sessionId })
      if (result.snapshot && this.historyManager) {
        const checkpoint = await this.historyManager.checkpoint(sessionId, result.snapshot)
        this.noteCheckpointResult(sessionId, checkpoint)
        if (checkpoint === 'committed') {
          // Keep the 45s success cooldown parity with the incremental path.
          this.lastFullCheckpointAt.set(sessionId, Date.now())
        }
        return mapHistoryCheckpointResult(checkpoint)
      }
      return this.historyManager ? 'no-snapshot' : 'permanently-unavailable'
    }
    if (opts.final || this.sessionsNeedingFullCheckpoint.has(sessionId)) {
      if (!opts.final) {
        // Exponential backoff: a failed full snapshot must not run on every tick.
        // Incremental appends are still allowed so new output is not lost meanwhile.
        if (this.isFullCheckpointBackingOff(sessionId)) {
          await this.appendIncrementsWhileBackingOff(sessionId)
          return 'deferred'
        }
        if (this.isFullCheckpointCoolingDown(sessionId)) {
          return 'deferred'
        }
      }
      // Drain and snapshot atomically so warm reattach cannot append records already in the checkpoint.
      const checkpoint = await this.takeSnapshotAndCheckpoint(sessionId, {
        teardown: opts.teardown,
        forceLiveSnapshot: this.sessionsNeedingLiveCheckpoint.has(sessionId),
        requireContinuityProof: this.sessionsNeedingContinuityCheckpoint.has(sessionId)
      })
      const writeResult = settledCheckpointOutcome(checkpoint)
      if (writeResult === 'deferred') {
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        return 'deferred'
      }
      if (writeResult !== 'committed') {
        return writeResult
      }
      this.sessionsNeedingFullCheckpoint.delete(sessionId)
      this.sessionsNeedingLiveCheckpoint.delete(sessionId)
      this.sessionsNeedingContinuityCheckpoint.delete(sessionId)
      return 'committed'
    }
    const take = await this.client.request<TakePendingOutputResult | null>('takePendingOutput', {
      sessionId
    })
    if (!take) {
      return 'committed'
    }
    if (take.overflowed) {
      // Dropped records leave a log gap; re-anchor with a full snapshot.
      if (!opts.final) {
        if (this.isFullCheckpointBackingOff(sessionId)) {
          this.sessionsNeedingFullCheckpoint.add(sessionId)
          return 'deferred'
        }
        if (this.isFullCheckpointCoolingDown(sessionId)) {
          this.sessionsNeedingFullCheckpoint.add(sessionId)
          return 'deferred'
        }
      }
      const checkpoint = await this.takeSnapshotAndCheckpoint(sessionId, {
        teardown: false,
        forceLiveSnapshot: true
      })
      const writeResult = settledCheckpointOutcome(checkpoint)
      if (writeResult === 'deferred') {
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        return 'deferred'
      }
      return writeResult
    }
    if (take.records.length === 0) {
      return 'committed'
    }
    if (!this.historyManager) {
      return 'permanently-unavailable'
    }
    const appendResult = await this.historyManager.appendIncrements(
      sessionId,
      take.seq,
      take.records
    )
    if (appendResult === 'needs-checkpoint') {
      // The emulator already contains these records; a full snapshot can replace the failed append.
      if (!opts.final) {
        if (this.isFullCheckpointBackingOff(sessionId)) {
          this.sessionsNeedingFullCheckpoint.add(sessionId)
          return 'deferred'
        }
        if (this.isFullCheckpointCoolingDown(sessionId)) {
          this.sessionsNeedingFullCheckpoint.add(sessionId)
          return 'deferred'
        }
      }
      const checkpoint = await this.takeSnapshotAndCheckpoint(sessionId, {
        teardown: false,
        forceLiveSnapshot: true
      })
      const writeResult = settledCheckpointOutcome(checkpoint)
      if (writeResult === 'deferred') {
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        return 'deferred'
      }
      return writeResult
    }
    return 'committed'
  }

  /** Best-effort incremental append while a full checkpoint is backing off (issue ①). */
  private async appendIncrementsWhileBackingOff(sessionId: string): Promise<void> {
    if (!this.historyManager) {
      return
    }
    try {
      const take = await this.client.request<TakePendingOutputResult | null>('takePendingOutput', {
        sessionId
      })
      if (!take || take.overflowed || take.records.length === 0) {
        return
      }
      await this.historyManager.appendIncrements(sessionId, take.seq, take.records)
    } catch (error) {
      console.warn('[history] backoff incremental append failed:', sessionId, error)
    }
  }

  /** `lastFullCheckpointAt` tracks success only; failures drive the separate backoff map. */
  private noteCheckpointResult(sessionId: string, result: HistoryCheckpointResult): void {
    if (result === 'retryable') {
      this.recordFullCheckpointFailure(sessionId)
      return
    }
    this.clearFullCheckpointBackoff(sessionId)
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
      // Missing drainedRecords on older daemons cannot mean empty: snapshotting still drained their queue.
      // Teardown records repeat held bytes already emitted; use drainedRecords to avoid replaying them twice.
      const durable =
        take.drainedRecords === undefined || opts.forceLiveSnapshot === true || take.overflowed
          ? take.snapshot
          : await this.buildDurableHistorySnapshot(sessionId, take.snapshot, take.drainedRecords, {
              isFirstTake: take.seq === 1,
              ...(opts.requireContinuityProof === true
                ? { requiredPreviousPendingOutputSeq: take.seq - 1 }
                : {})
            })
      // Set only inside an exclusive final pass (Sleep or quit), so no other checkpoint sees it.
      const probedCwd = this.probedShellCwds.get(sessionId)
      const snapshot = probedCwd ? { ...durable, cwd: probedCwd } : durable
      const checkpoint = await this.historyManager.checkpoint(sessionId, snapshot, {
        pendingOutputSeq: take.seq
      })
      if (checkpoint === 'retryable') {
        this.recordFullCheckpointFailure(sessionId)
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        this.sessionsNeedingLiveCheckpoint.add(sessionId)
        this.sessionsNeedingContinuityCheckpoint.delete(sessionId)
        this.markSessionDirty(sessionId)
        return { checkpoint, snapshot: take.snapshot }
      }
      if (checkpoint === 'unavailable') {
        this.clearFullCheckpointBackoff(sessionId)
        this.sessionsNeedingFullCheckpoint.delete(sessionId)
        this.sessionsNeedingLiveCheckpoint.delete(sessionId)
        this.sessionsNeedingContinuityCheckpoint.delete(sessionId)
        return { checkpoint, snapshot: take.snapshot }
      }
      this.lastFullCheckpointAt.set(sessionId, Date.now())
      this.clearFullCheckpointBackoff(sessionId)
      this.sessionsNeedingLiveCheckpoint.delete(sessionId)
      this.sessionsNeedingContinuityCheckpoint.delete(sessionId)
      return { checkpoint: 'committed', snapshot }
    }
    this.sessionsNeedingFullCheckpoint.delete(sessionId)
    this.sessionsNeedingLiveCheckpoint.delete(sessionId)
    this.sessionsNeedingContinuityCheckpoint.delete(sessionId)
    return this.historyManager
      ? { checkpoint: 'no-snapshot', snapshot: null }
      : { checkpoint: 'unavailable', snapshot: take?.snapshot ?? null }
  }

  protected async buildDurableHistorySnapshot(
    sessionId: string,
    liveSnapshot: NonNullable<TakePendingOutputResult['snapshot']>,
    pendingRecords: TakePendingOutputResult['records'],
    opts: {
      isFirstTake: boolean
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
        (!restoreInfo && !opts.isFirstTake) ||
        (opts.requiredPreviousPendingOutputSeq !== undefined &&
          restoreInfo?.pendingOutputSeq !== opts.requiredPreviousPendingOutputSeq)
      ) {
        console.warn('[history] durable continuity unproven; using live snapshot:', sessionId)
        return liveSnapshot
      }
      return await buildDurableCheckpointSnapshot({
        liveSnapshot,
        restoreInfo,
        pendingRecords,
        isFirstTake: opts.isFirstTake,
        resizeModel: this.historyManager?.hostingResizeModel()
      })
    } catch (error) {
      console.warn('[history] durable history rebuild failed:', sessionId, error)
      return liveSnapshot
    }
  }
}
