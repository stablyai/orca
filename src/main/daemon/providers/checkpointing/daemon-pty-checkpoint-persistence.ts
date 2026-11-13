import { TerminalHistoryUnavailableError } from '../../protocol/daemon-history-protocol'
import { buildDurableCheckpointSnapshot } from './daemon-durable-history-snapshot'
import { DaemonPtyCheckpointScheduler } from './daemon-pty-checkpoint-scheduler'
import type { SnapshotCheckpointResult } from '../adapter/daemon-pty-runtime-state'
import type { GetSnapshotResult, TakePendingOutputResult } from '../../protocol/daemon-rpc-contract'
import type { CapturedHistoryWriter } from '../../history/storage/history-manager'
import type { ColdRestoreInfo } from '../../history/restoration/terminal-history-cold-restore-info'

export abstract class DaemonPtyCheckpointPersistence extends DaemonPtyCheckpointScheduler {
  // Defer without appending so cooldown preserves a consistent log prefix; keep the session dirty for retry.
  protected async writeSessionCheckpoint(
    sessionId: string,
    opts: { final: boolean; teardown: boolean; writer?: CapturedHistoryWriter | null }
  ): Promise<'done' | 'deferred'> {
    if (!this.supportsIncrementalCheckpoints) {
      const result = await this.client.request<GetSnapshotResult>('getSnapshot', { sessionId })
      if (result.snapshot && this.historyManager) {
        const checkpoint = await this.historyManager.checkpoint(
          sessionId,
          result.snapshot,
          undefined,
          opts.writer
        )
        return checkpoint === 'retryable' ? 'deferred' : 'done'
      }
      return 'done'
    }
    if (opts.final || this.sessionsNeedingFullCheckpoint.has(sessionId)) {
      if (!opts.final && this.isFullCheckpointCoolingDown(sessionId)) {
        return 'deferred'
      }
      // Drain and snapshot atomically so warm reattach cannot append records already in the checkpoint.
      const checkpoint = await this.takeSnapshotAndCheckpoint(sessionId, {
        teardown: opts.teardown,
        writer: opts.writer,
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
      // Dropped records leave a log gap; re-anchor with a full snapshot.
      if (this.isFullCheckpointCoolingDown(sessionId)) {
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        return 'deferred'
      }
      const checkpoint = await this.takeSnapshotAndCheckpoint(sessionId, {
        teardown: false,
        writer: opts.writer,
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
      take.records,
      opts.writer
    )
    if (appendResult === 'needs-checkpoint') {
      // The emulator already contains these records; a full snapshot can replace the failed append.
      if (this.isFullCheckpointCoolingDown(sessionId)) {
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        return 'deferred'
      }
      const checkpoint = await this.takeSnapshotAndCheckpoint(sessionId, {
        teardown: false,
        writer: opts.writer,
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
      writer?: CapturedHistoryWriter | null
    }
  ): Promise<SnapshotCheckpointResult> {
    // The complete saved source comes first, so a source that keeps changing consumes no output.
    let source: { restoreInfo: ColdRestoreInfo | null } | null = null
    const historyReader = this.historyReader
    if (this.historyManager && historyReader && opts.forceLiveSnapshot !== true) {
      try {
        source = {
          restoreInfo: await historyReader.detectColdRestore(sessionId, {
            ignoreCleanEnd: true,
            wslDistro: this.wslDistrosBySessionId.get(sessionId)
          })
        }
      } catch (error) {
        if (error instanceof TerminalHistoryUnavailableError) {
          // Nothing drained: the daemon's ordered queue keeps every record for the next full pass.
          this.sessionsNeedingFullCheckpoint.add(sessionId)
          this.markSessionDirty(sessionId)
          return { checkpoint: 'retryable', snapshot: null }
        }
        console.warn('[history] durable history rebuild failed:', sessionId, error)
      }
      // A writer replaced during the read no longer owns this checkpoint; its successor drains.
      const writer =
        opts.writer === undefined ? this.historyManager.captureWriter(sessionId) : opts.writer
      if (!writer?.writer.admitted) {
        this.sessionsNeedingFullCheckpoint.delete(sessionId)
        this.sessionsNeedingLiveCheckpoint.delete(sessionId)
        this.sessionsNeedingContinuityCheckpoint.delete(sessionId)
        return { checkpoint: 'unavailable', snapshot: null }
      }
    }
    const take = await this.client.request<TakePendingOutputResult | null>('takePendingOutput', {
      sessionId,
      includeSnapshot: true,
      teardownSnapshot: opts.teardown
    })
    if (take?.snapshot && this.historyManager) {
      // Missing drainedRecords on older daemons cannot mean empty: snapshotting still drained their queue.
      // Teardown records repeat held bytes already emitted; use drainedRecords to avoid replaying them twice.
      const durable =
        take.drainedRecords === undefined ||
        opts.forceLiveSnapshot === true ||
        take.overflowed ||
        !source
          ? take.snapshot
          : await this.buildDurableHistoryFromSource(
              sessionId,
              take.snapshot,
              source.restoreInfo,
              take.drainedRecords,
              {
                isFirstTake: take.seq === 1,
                ...(opts.requireContinuityProof === true
                  ? { requiredPreviousPendingOutputSeq: take.seq - 1 }
                  : {})
              }
            )
      // Set only inside an exclusive final pass (Sleep or quit), so no other checkpoint sees it.
      const probedCwd = this.probedShellCwds.get(sessionId)
      const snapshot = probedCwd ? { ...durable, cwd: probedCwd } : durable
      const checkpoint = await this.historyManager.checkpoint(
        sessionId,
        snapshot,
        { pendingOutputSeq: take.seq },
        opts.writer
      )
      if (checkpoint === 'retryable') {
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
      this.sessionsNeedingLiveCheckpoint.delete(sessionId)
      this.sessionsNeedingContinuityCheckpoint.delete(sessionId)
      return { checkpoint: 'committed', snapshot }
    }
    this.sessionsNeedingFullCheckpoint.delete(sessionId)
    this.sessionsNeedingLiveCheckpoint.delete(sessionId)
    this.sessionsNeedingContinuityCheckpoint.delete(sessionId)
    return { checkpoint: 'unavailable', snapshot: take?.snapshot ?? null }
  }

  /** The complete history from a source captured before the drain plus every drained record, once. */
  protected async buildDurableHistoryFromSource(
    sessionId: string,
    liveSnapshot: NonNullable<TakePendingOutputResult['snapshot']>,
    restoreInfo: ColdRestoreInfo | null,
    pendingRecords: TakePendingOutputResult['records'],
    opts: {
      isFirstTake: boolean
      requiredPreviousPendingOutputSeq?: number
    }
  ): Promise<NonNullable<TakePendingOutputResult['snapshot']>> {
    if (
      (!restoreInfo && !opts.isFirstTake) ||
      (opts.requiredPreviousPendingOutputSeq !== undefined &&
        restoreInfo?.pendingOutputSeq !== opts.requiredPreviousPendingOutputSeq)
    ) {
      console.warn('[history] durable continuity unproven; using live snapshot:', sessionId)
      return liveSnapshot
    }
    try {
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
