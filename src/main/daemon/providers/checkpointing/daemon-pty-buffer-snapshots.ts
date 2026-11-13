import { normalizeDesktopTerminalSnapshotRows } from '../../../../shared/terminal/replay/terminal-scrollback-policy'
import { parseTerminalKittyKeyboardFlags } from '../../../../shared/terminal/protocol/input-modes/terminal-kitty-keyboard-flags'
import { boundSnapshot } from './daemon-durable-history-snapshot'
import { DaemonPtySessionControl } from '../adapter/daemon-pty-session-control'
import { isUnknownRequestTypeError } from '../../endpoint/identity/daemon-endpoint-errors'
import { focusLossReportSupport } from '../../protocol/daemon-protocol-version'
import { DAEMON_SESSION_SCROLLBACK_ROWS } from '../../sessions/daemon-session-scrollback-window'
import type { GetSnapshotResult } from '../../protocol/daemon-rpc-contract'
import type { PtyProviderBufferSnapshot } from '../../../providers/pty/provider-contract'
import type { CapturedHistoryWriter } from '../../history/storage/history-manager'
import { readHostHistorySnapshot, type ShutdownOptions } from '../adapter/daemon-pty-host-history'
import { FinalCheckpointWaitExpiredError } from '../adapter/daemon-pty-lifecycle-errors'
import { normalizeWslColdRestoreCwd } from '../wsl/wsl-cold-restore-cwd'
import { resolveSafePtyDefaultCwd } from '../../../providers/working-directory/default-cwd'

const DURABLE_HISTORY_OVERLAY_DEADLINE_MS = 5_000

export abstract class DaemonPtyBufferSnapshots extends DaemonPtySessionControl {
  async getBufferSnapshot(
    id: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<PtyProviderBufferSnapshot | null> {
    if (!this.supportsAuthoritativeBufferSnapshots) {
      return null
    }
    if (this.hostHistory.enabled) {
      const incarnationId = this.hostHistory.get(id)?.incarnationId
      const snapshot = await readHostHistorySnapshot(
        this.client,
        id,
        incarnationId,
        opts.scrollbackRows
      )
      // A same-ID successor bound during the read must never receive the old incarnation's image.
      return snapshot && this.hostHistory.get(id)?.incarnationId === incarnationId
        ? this.toProviderBufferSnapshot(snapshot)
        : null
    }
    try {
      const scrollbackRows = normalizeDesktopTerminalSnapshotRows(opts.scrollbackRows)
      const result = await this.client.request<GetSnapshotResult>('getSnapshot', {
        sessionId: id,
        ...(scrollbackRows !== undefined ? { scrollbackRows } : {})
      })
      const snapshot = result.snapshot
      // Older v19 snapshots lack the absolute sequence needed to reconcile data queued on the other socket.
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
      // Preserve known zero keyboard flags; absence means the source cannot report them.
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
    // Reject redundant compaction work rather than growing a queue behind stalled history I/O.
    if (this.checkpointQueue.isSaturated(sessionId)) {
      return liveSnapshot
    }
    // Reserve before enqueueing: simultaneous mounts and abandoned waits must count until writes settle.
    if (!this.tryAdmitNonFinalCheckpoint(sessionId)) {
      return liveSnapshot
    }
    const writer = this.historyManager.captureWriter(sessionId) ?? null
    // Bound this session's reattach wait; timed-out compaction still commits durable history.
    return await this.checkpointQueue.runWithDeadline(
      sessionId,
      async () => {
        try {
          return await this.compactDurableRestoreSnapshot(
            sessionId,
            liveSnapshot,
            scrollbackRows,
            writer
          )
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
    scrollbackRows: number | undefined,
    writer: CapturedHistoryWriter | null
  ): Promise<NonNullable<GetSnapshotResult['snapshot']>> {
    if (!this.historyReader) {
      return liveSnapshot
    }
    try {
      // Compact before reading to avoid racing the periodic checkpoint and creating a sequence gap.
      const checkpoint = await this.takeSnapshotAndCheckpoint(sessionId, {
        teardown: false,
        writer,
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

  protected async saveLegacySleepHistory(
    id: string,
    opts: ShutdownOptions,
    sleepCwd: string | null
  ): Promise<void> {
    let saved = false
    const committed = await this.runExclusiveCheckpoint(
      async () => {
        // Set inside: a caller past its deadline leaves this checkpoint running without it.
        if (sleepCwd) {
          this.probedShellCwds.set(id, sleepCwd)
        }
        try {
          const completed = await this.checkpointSessions([id], { final: true, teardown: true })
          saved = completed.has(id)
        } finally {
          this.probedShellCwds.delete(id)
        }
      },
      { callerDeadlineMs: opts.deadlineMs }
    )
    // Caller timeout leaves the checkpoint running, and a deferred final save (its source kept
    // changing) saved nothing new: either way the live PTY stays until recovery data is saved.
    if (!committed || (this.historyManager && !saved)) {
      throw new FinalCheckpointWaitExpiredError(id)
    }
    const wslDistro = this.wslDistrosBySessionId.get(id)
    const detection = await this.historyReader?.detectColdRestoreState(id, { wslDistro })
    const detected = detection?.status === 'restored' ? detection.restoreInfo : null
    const restoreInfo = detected
      ? {
          ...detected,
          cwd:
            normalizeWslColdRestoreCwd({
              recoveredCwd: detected.cwd,
              requestedCwd: this.initialCwds.get(id) ?? resolveSafePtyDefaultCwd(),
              wslDistro
            }) ?? ''
        }
      : null
    const coldRestore = restoreInfo ? this.buildColdRestorePayload(restoreInfo) : null
    const unreadable =
      detection?.status === 'unreadable' ||
      (detection?.status === 'restored' && detection.hasUnreadableRecovery)
    if (coldRestore) {
      this.coldRestoreCache.set(id, coldRestore)
      if (this.coldRestoreCache.has(id)) {
        this.sleepRestoreSessionIds.add(id)
      }
      // Intentional sleep keeps the final checkpoint authoritative; physical exit must not mark history clean.
      this.historyManager?.suspendSession(id)
    } else if (unreadable) {
      this.historyManager?.suspendSession(id)
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

  acknowledgeDataEvent(_id: string, _charCount: number): void {}
}
