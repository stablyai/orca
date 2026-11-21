import { normalizeDesktopTerminalSnapshotRows } from '../../../../shared/terminal/replay/terminal-scrollback-policy'
import { parseTerminalKittyKeyboardFlags } from '../../../../shared/terminal/protocol/input-modes/terminal-kitty-keyboard-flags'
import { boundSnapshot } from './daemon-durable-history-snapshot'
import { DaemonPtySessionControl } from '../adapter/daemon-pty-session-control'
import { isUnknownRequestTypeError } from '../../endpoint/identity/daemon-endpoint-errors'
import {
  focusLossReportSupport,
  REPAINT_REQUEST_PROTOCOL_VERSION,
  VISIBLE_PROJECTION_SNAPSHOT_PROTOCOL_VERSION
} from '../../protocol/daemon-protocol-version'
import { DAEMON_SESSION_SCROLLBACK_ROWS } from '../../sessions/daemon-session-scrollback-window'
import type { GetSnapshotResult } from '../../protocol/daemon-rpc-contract'
import type {
  TerminalSnapshot,
  TerminalVisibleProjectionSnapshot
} from '../../protocol/terminal-snapshot'
import type {
  PtyProviderBufferSnapshot,
  PtyProviderBufferSnapshotOptions
} from '../../../providers/pty/provider-contract'

const DURABLE_HISTORY_OVERLAY_DEADLINE_MS = 5_000

export abstract class DaemonPtyBufferSnapshots extends DaemonPtySessionControl {
  supportsVisibleProjectionSnapshot(): boolean {
    return this.protocolVersion >= VISIBLE_PROJECTION_SNAPSHOT_PROTOCOL_VERSION
  }

  async getBufferSnapshot(
    id: string,
    opts: PtyProviderBufferSnapshotOptions = {}
  ): Promise<PtyProviderBufferSnapshot | null> {
    if (!this.supportsAuthoritativeBufferSnapshots) {
      return null
    }
    try {
      const visibleProjection = opts.visibleProjection && this.supportsVisibleProjectionSnapshot()
      const scrollbackRows = opts.visibleProjection
        ? 0
        : normalizeDesktopTerminalSnapshotRows(opts.scrollbackRows)
      const { snapshot } = await this.client.request<
        GetSnapshotResult<TerminalSnapshot | TerminalVisibleProjectionSnapshot>
      >('getSnapshot', {
        sessionId: id,
        ...(scrollbackRows !== undefined ? { scrollbackRows } : {}),
        ...(visibleProjection ? { visibleProjection: true } : {})
      })
      // Older v19 snapshots lack the absolute sequence needed to reconcile data queued on the other socket.
      if (!snapshot || typeof snapshot.outputSequence !== 'number') {
        return null
      }
      if ('visibleProjection' in snapshot) {
        return visibleProjection ? this.toProviderBufferSnapshot(snapshot) : null
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
    snapshot: TerminalSnapshot | TerminalVisibleProjectionSnapshot
  ): PtyProviderBufferSnapshot | null {
    if (typeof snapshot.outputSequence !== 'number') {
      return null
    }
    const kittyKeyboardFlags = parseTerminalKittyKeyboardFlags(snapshot.modes.kittyKeyboardFlags)
    return {
      ...('visibleProjection' in snapshot
        ? { data: '', visibleProjection: snapshot.visibleProjection }
        : {
            data: snapshot.rehydrateSequences + snapshot.snapshotAnsi,
            frameRestoreAnsi: snapshot.frameRestoreAnsi,
            scrollbackAnsi: snapshot.scrollbackAnsi,
            oscLinks: snapshot.oscLinks,
            ...(snapshot.pendingEscapeTailAnsi
              ? { pendingEscapeTailAnsi: snapshot.pendingEscapeTailAnsi }
              : {})
          }),
      cols: snapshot.cols,
      rows: snapshot.rows,
      cwd: snapshot.cwd,
      lastTitle: snapshot.lastTitle,
      seq: snapshot.outputSequence,
      source: 'headless',
      alternateScreen: snapshot.modes.alternateScreen,
      // Preserve known zero keyboard flags; absence means the source cannot report them.
      ...(kittyKeyboardFlags !== undefined ? { kittyKeyboardFlags } : {}),
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
    // Reject redundant compaction work rather than growing a queue behind stalled history I/O.
    if (this.checkpointQueue.isSaturated(sessionId)) {
      return liveSnapshot
    }
    // Reserve before enqueueing: simultaneous mounts and abandoned waits must count until writes settle.
    if (!this.tryAdmitNonFinalCheckpoint(sessionId)) {
      return liveSnapshot
    }
    // Bound this session's reattach wait; timed-out compaction still commits durable history.
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
      return scrollbackRows !== undefined && checkpoint.snapshot.scrollbackLines > scrollbackRows
        ? await boundSnapshot(checkpoint.snapshot, scrollbackRows)
        : checkpoint.snapshot
    } catch (error) {
      console.warn('[history] durable snapshot overlay failed:', sessionId, error)
      return liveSnapshot
    }
  }

  async clearBuffer(id: string): Promise<void> {
    await this.client.request('clearScrollback', { sessionId: id })
    this.markSessionDirty(id)
  }

  async resetInputModes(id: string): Promise<void> {
    await this.client.request('resetInputModes', { sessionId: id })
    this.markSessionDirty(id)
  }

  async reportFocusLost(id: string): Promise<void> {
    const support = focusLossReportSupport(this.protocolVersion)
    if (support === 'unsupported' || (support === 'ask' && this.focusLossReportRejected)) {
      return
    }
    try {
      await this.client.request('reportFocusLost', { sessionId: id })
    } catch (error) {
      if (support !== 'ask' || !isUnknownRequestTypeError(error)) {
        throw error
      }
      // A v55 daemon from 1.4.251 predates the request; its replacement is asked again.
      this.focusLossReportRejected = true
    }
  }

  async requestRepaint(id: string): Promise<void> {
    if (this.protocolVersion >= REPAINT_REQUEST_PROTOCOL_VERSION) {
      await this.client.request('requestRepaint', { sessionId: id })
    }
  }

  acknowledgeDataEvent(_id: string, _charCount: number): void {}
}
