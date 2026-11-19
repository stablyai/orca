import { boundSnapshot } from './daemon-durable-history-snapshot'
import { sameHistoryIdentity, type DurableHistoryReadScope } from './settled-durable-history'
import { DaemonPtySessionControl } from '../adapter/daemon-pty-session-control'
import type { TerminalSnapshot } from '../../protocol/terminal-snapshot'
import { DAEMON_SESSION_SCROLLBACK_ROWS } from '../../sessions/daemon-session-scrollback-window'
import type { GetSnapshotResult } from '../../protocol/daemon-rpc-contract'

const DURABLE_HISTORY_OVERLAY_DEADLINE_MS = 5_000

type OverlayRead = {
  scope: DurableHistoryReadScope
  completedSnapshot?: TerminalSnapshot
  historyLimited?: true
}

export abstract class DaemonPtyDurableHistoryOverlay extends DaemonPtySessionControl {
  protected async readSettledDurableHistory(
    sessionId: string,
    live: TerminalSnapshot,
    scrollbackRows: number,
    scope: DurableHistoryReadScope
  ): Promise<{ snapshot: TerminalSnapshot; historyLimited?: true }> {
    const needsAnchor =
      this.sessionsNeedingLiveCheckpoint.has(sessionId) ||
      this.sessionsNeedingContinuityCheckpoint.has(sessionId)
    const cached =
      !needsAnchor && scope.valid ? this.settledDurableHistory.get(sessionId, live) : undefined
    if (cached) {
      const bounded =
        cached.scrollbackLines > scrollbackRows
          ? await boundSnapshot(cached, scrollbackRows)
          : cached
      const latest = bounded === cached ? live : await this.readLiveHistoryWindow(sessionId)
      if (scope.valid && latest && sameHistoryIdentity(cached, latest)) {
        return { snapshot: this.withLiveIdentity(bounded, latest) }
      }
      this.settledDurableHistory.delete(sessionId)
      return { snapshot: latest ?? live, historyLimited: true }
    }
    const read: OverlayRead = { scope }
    const snapshot = await this.overlayDurableRestoreSnapshot(sessionId, live, scrollbackRows, read)
    if (read.completedSnapshot !== snapshot) {
      return {
        snapshot: (await this.readLiveHistoryWindow(sessionId)) ?? live,
        historyLimited: true
      }
    }
    return { snapshot, ...(read.historyLimited ? { historyLimited: true } : {}) }
  }

  private async readLiveHistoryWindow(sessionId: string): Promise<TerminalSnapshot | null> {
    const result = await this.client.request<GetSnapshotResult>('getSnapshot', {
      sessionId,
      scrollbackRows: DAEMON_SESSION_SCROLLBACK_ROWS
    })
    return result.snapshot
  }

  private withLiveIdentity(history: TerminalSnapshot, live: TerminalSnapshot): TerminalSnapshot {
    return {
      ...history,
      cwd: live.cwd,
      lastTitle: live.lastTitle,
      terminalOwner: live.terminalOwner,
      modes: live.modes,
      rehydrateSequences: live.rehydrateSequences,
      frameRestoreAnsi: live.frameRestoreAnsi,
      pendingEscapeTailAnsi: live.pendingEscapeTailAnsi
    }
  }

  protected async overlayDurableRestoreSnapshot(
    sessionId: string,
    liveSnapshot: NonNullable<GetSnapshotResult['snapshot']>,
    scrollbackRows?: number,
    read?: OverlayRead
  ): Promise<NonNullable<GetSnapshotResult['snapshot']>> {
    if (!this.historyManager || !this.historyReader) {
      return liveSnapshot
    }
    // Reject redundant compaction work rather than growing a queue behind stalled history I/O.
    if (this.checkpointQueue.isSaturated(sessionId)) {
      return liveSnapshot
    }
    // Reserve before enqueueing: simultaneous mounts and abandoned waits must count until writes settle.
    if (!this.tryAdmitNonFinalCheckpoint(sessionId)) {
      return liveSnapshot
    }
    if (read) {
      read.scope.readers++
    }
    // Bound this session's reattach wait; timed-out compaction still commits durable history.
    return await this.checkpointQueue.runWithDeadline(
      sessionId,
      async () => {
        try {
          return await this.compactDurableRestoreSnapshot(
            sessionId,
            liveSnapshot,
            scrollbackRows,
            read
          )
        } finally {
          if (read) {
            this.settledDurableHistory.end(sessionId, read.scope)
          }
          this.releaseNonFinalCheckpointAdmission(sessionId)
          this.overlayDeadlineWarnedSessionIds.delete(sessionId)
        }
      },
      DURABLE_HISTORY_OVERLAY_DEADLINE_MS,
      liveSnapshot,
      {
        onDeadline: () => {
          if (!this.overlayDeadlineWarnedSessionIds.has(sessionId)) {
            this.overlayDeadlineWarnedSessionIds.add(sessionId)
            console.warn('[history] durable snapshot overlay deadline exceeded:', sessionId)
          }
        }
      }
    )
  }

  protected tryAdmitNonFinalCheckpoint(sessionId: string): boolean {
    if (this.nonFinalCheckpointAdmissionSessionIds.has(sessionId)) {
      if (!this.nonFinalAdmissionDeniedSessionIds.has(sessionId)) {
        this.nonFinalAdmissionDeniedSessionIds.add(sessionId)
        console.warn('[history] non-final checkpoint already in flight:', sessionId)
      }
      return false
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every adapter constructor inherits this checkpoint admission constant.
    const admissionLimit = (this.constructor as typeof DaemonPtyDurableHistoryOverlay)
      .MAX_CONCURRENT_CHECKPOINTS
    if (this.nonFinalCheckpointAdmissionSessionIds.size >= admissionLimit) {
      this.reportNonFinalGlobalAdmissionDenial(sessionId)
      return false
    }
    this.nonFinalAdmissionDeniedSessionIds.delete(sessionId)
    this.nonFinalCheckpointAdmissionSessionIds.add(sessionId)
    return true
  }

  protected reportNonFinalGlobalAdmissionDenial(sessionId: string): void {
    if (!this.nonFinalGlobalAdmissionWarningActive) {
      this.nonFinalGlobalAdmissionWarningActive = true
      console.warn('[history] non-final checkpoint global admission limit reached:', sessionId)
    }
  }

  protected releaseNonFinalCheckpointAdmission(sessionId: string): void {
    if (this.nonFinalCheckpointAdmissionSessionIds.delete(sessionId)) {
      this.nonFinalAdmissionDeniedSessionIds.delete(sessionId)
      this.nonFinalGlobalAdmissionWarningActive = false
    }
  }

  protected async compactDurableRestoreSnapshot(
    sessionId: string,
    liveSnapshot: NonNullable<GetSnapshotResult['snapshot']>,
    scrollbackRows?: number,
    read?: OverlayRead
  ): Promise<NonNullable<GetSnapshotResult['snapshot']>> {
    if (!this.historyReader) {
      return liveSnapshot
    }
    try {
      // Compact before reading to avoid racing the periodic checkpoint and creating a sequence gap.
      const checkpoint = await this.takeSnapshotAndCheckpoint(sessionId, {
        teardown: false,
        forceLiveSnapshot: this.sessionsNeedingLiveCheckpoint.has(sessionId),
        requireContinuityProof: this.sessionsNeedingContinuityCheckpoint.has(sessionId)
      })
      if (checkpoint.checkpoint === 'committed') {
        this.sessionsNeedingFullCheckpoint.delete(sessionId)
      }
      if (checkpoint.checkpoint !== 'committed' || !checkpoint.snapshot) {
        return checkpoint.snapshot ?? liveSnapshot
      }
      const snapshot = checkpoint.snapshot
      const bounded =
        scrollbackRows !== undefined && snapshot.scrollbackLines > scrollbackRows
          ? await boundSnapshot(snapshot, scrollbackRows)
          : snapshot
      if (!read) {
        return bounded
      }
      // Revalidate after both persistence and bounding, including mutations from other clients.
      const latest = await this.readLiveHistoryWindow(sessionId)
      if (!latest || !read.scope.valid) {
        return latest ?? liveSnapshot
      }
      const authoritative =
        snapshot.historyRevision !== undefined && snapshot.sessionIncarnationId !== undefined
      if (authoritative && !sameHistoryIdentity(snapshot, latest)) {
        this.settledDurableHistory.delete(sessionId)
        return latest
      }
      if (checkpoint.historyComplete === true && authoritative) {
        this.settledDurableHistory.retain(sessionId, snapshot, read.scope)
      }
      const result = this.withLiveIdentity(bounded, latest)
      // Incomplete older coverage still contributes a verified suffix beyond the live window.
      read.completedSnapshot = result
      if (checkpoint.historyComplete !== true) {
        read.historyLimited = true
      }
      return result
    } catch (error) {
      console.warn('[history] durable snapshot overlay failed:', sessionId, error)
      return liveSnapshot
    }
  }
}
