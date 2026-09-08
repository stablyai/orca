import { normalizeDesktopTerminalSnapshotRows } from '../../shared/terminal-scrollback-policy'
import { parseTerminalKittyKeyboardFlags } from '../../shared/terminal-kitty-keyboard-flags'
import { buildDurableCheckpointSnapshot } from './daemon-durable-history-snapshot'
import { DaemonPtySessionControl } from './daemon-pty-session-control'
import { DAEMON_RESTORE_SCROLLBACK_ROWS } from './daemon-restore-scrollback-depth'
import { DAEMON_SESSION_SCROLLBACK_ROWS } from './daemon-session-scrollback-window'
import type { GetSnapshotResult } from './types'
import type { PtyProviderBufferSnapshot } from '../providers/types'

const DURABLE_HISTORY_OVERLAY_DEADLINE_MS = 5_000

export abstract class DaemonPtyBufferSnapshots extends DaemonPtySessionControl {
  async getBufferSnapshot(
    id: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<PtyProviderBufferSnapshot | null> {
    if (!this.supportsAuthoritativeBufferSnapshots) {
      return null
    }
    try {
      const scrollbackRows = normalizeDesktopTerminalSnapshotRows(opts.scrollbackRows)
      const result = await this.client.request<GetSnapshotResult>('getSnapshot', {
        sessionId: id,
        ...(scrollbackRows !== undefined ? { scrollbackRows } : {})
      })
      const snapshot = result.snapshot
      // Why: older v19 daemons lack an absolute output sequence, so their snapshot can't reconcile bytes queued on the other socket.
      if (!snapshot || typeof snapshot.outputSequence !== 'number') {
        return null
      }
      const restored =
        this.historyManager &&
        this.historyReader &&
        (scrollbackRows === undefined || scrollbackRows > DAEMON_SESSION_SCROLLBACK_ROWS)
          ? await this.overlayDurableRestoreSnapshot(id, snapshot, scrollbackRows)
          : snapshot
      return this.toProviderBufferSnapshot(restored)
    } catch {
      return null
    }
  }

  protected toProviderBufferSnapshot(
    snapshot: NonNullable<GetSnapshotResult['snapshot']>
  ): PtyProviderBufferSnapshot | null {
    if (typeof snapshot.outputSequence !== 'number') {
      return null
    }
    const kittyKeyboardFlags = parseTerminalKittyKeyboardFlags(snapshot.modes.kittyKeyboardFlags)
    return {
      data: snapshot.rehydrateSequences + snapshot.snapshotAnsi,
      frameRestoreAnsi: snapshot.frameRestoreAnsi,
      scrollbackAnsi: snapshot.scrollbackAnsi,
      cols: snapshot.cols,
      rows: snapshot.rows,
      cwd: snapshot.cwd,
      lastTitle: snapshot.lastTitle,
      seq: snapshot.outputSequence,
      source: 'headless',
      oscLinks: snapshot.oscLinks,
      alternateScreen: snapshot.modes.alternateScreen,
      // Why known `0` is carried too: it proves the app negotiated nothing at
      // this boundary, which is a different fact from a source that cannot say.
      ...(kittyKeyboardFlags !== undefined ? { kittyKeyboardFlags } : {}),
      ...(snapshot.pendingEscapeTailAnsi
        ? { pendingEscapeTailAnsi: snapshot.pendingEscapeTailAnsi }
        : {}),
      ...(snapshot.terminalOwner ? { terminalOwner: snapshot.terminalOwner } : {})
    }
  }

  protected async overlayDurableRestoreSnapshot(
    sessionId: string,
    liveSnapshot: NonNullable<GetSnapshotResult['snapshot']>,
    scrollbackRows?: number
  ): Promise<NonNullable<GetSnapshotResult['snapshot']>> {
    if (!this.historyManager || !this.historyReader) {
      return liveSnapshot
    }
    // Why turn the caller away instead of queueing: this session already has a
    // compact in flight whose result a third one would only duplicate, and an
    // unbounded queue is how a stalled history filesystem grows without limit.
    if (this.checkpointQueue.isSaturated(sessionId)) {
      return liveSnapshot
    }
    // Why reserve before enqueueing: pane mounts can arrive in one turn, before any compact starts.
    // Count abandoned waits until their writes settle so a relaunch cannot fan out unbounded work.
    if (!this.tryAdmitNonFinalCheckpoint(sessionId)) {
      return liveSnapshot
    }
    // Why per session with a deadline: a reattach is a user click, so it must wait
    // on this session's own compact and nothing else. A blown deadline does not
    // cancel that compact — it keeps running and still commits — so the fallback
    // costs restore depth for this one reattach, never durable history (STA-4173).
    return await this.checkpointQueue.runWithDeadline(
      sessionId,
      async () => {
        try {
          return await this.compactDurableRestoreSnapshot(sessionId, liveSnapshot, scrollbackRows)
        } finally {
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
    if (
      this.nonFinalCheckpointAdmissionSessionIds.size >=
      (this.constructor as typeof DaemonPtyBufferSnapshots).MAX_CONCURRENT_CHECKPOINTS
    ) {
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
    scrollbackRows?: number
  ): Promise<NonNullable<GetSnapshotResult['snapshot']>> {
    if (!this.historyReader) {
      return liveSnapshot
    }
    try {
      // Why compact before reading: an independent take/append races the 5s tick, can
      // seq-gap the log, and would remount a stale checkpoint over the live window.
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
      if (scrollbackRows === undefined || scrollbackRows >= DAEMON_RESTORE_SCROLLBACK_ROWS) {
        return checkpoint.snapshot
      }
      const restoreInfo = await this.historyReader.detectColdRestore(sessionId, {
        ignoreCleanEnd: true,
        wslDistro: this.wslDistrosBySessionId.get(sessionId)
      })
      if (!restoreInfo) {
        return liveSnapshot
      }
      return await buildDurableCheckpointSnapshot({
        liveSnapshot: checkpoint.snapshot,
        restoreInfo,
        scrollbackRows
      })
    } catch (error) {
      console.warn('[history] durable snapshot overlay failed:', sessionId, error)
      return liveSnapshot
    }
  }

  async clearBuffer(id: string): Promise<void> {
    await this.client.request('clearScrollback', { sessionId: id })
    this.markSessionDirty(id)
  }

  acknowledgeDataEvent(_id: string, _charCount: number): void {
    // No flow control for daemon-backed terminals
  }
}
