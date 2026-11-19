import { normalizeDesktopTerminalSnapshotRows } from '../../../../shared/terminal/replay/terminal-scrollback-policy'
import { parseTerminalKittyKeyboardFlags } from '../../../../shared/terminal/protocol/input-modes/terminal-kitty-keyboard-flags'
import { DaemonPtyDurableHistoryOverlay } from './daemon-pty-durable-history-overlay'
import { isUnknownRequestTypeError } from '../../endpoint/identity/daemon-endpoint-errors'
import {
  focusLossReportSupport,
  REPAINT_REQUEST_PROTOCOL_VERSION
} from '../../protocol/daemon-protocol-version'
import { DAEMON_SESSION_SCROLLBACK_ROWS } from '../../sessions/daemon-session-scrollback-window'
import type { GetSnapshotResult } from '../../protocol/daemon-rpc-contract'
import type { PtyProviderBufferSnapshot } from '../../../providers/pty/provider-contract'

export abstract class DaemonPtyBufferSnapshots extends DaemonPtyDurableHistoryOverlay {
  async getBufferSnapshot(
    id: string,
    opts: { scrollbackRows?: number; signal?: AbortSignal; recovery?: true } = {}
  ): Promise<PtyProviderBufferSnapshot | null> {
    if (!this.supportsAuthoritativeBufferSnapshots) {
      return null
    }
    const scope = this.settledDurableHistory.begin(id)
    try {
      const scrollbackRows = normalizeDesktopTerminalSnapshotRows(opts.scrollbackRows)
      const payload = {
        sessionId: id,
        ...(scrollbackRows !== undefined ? { scrollbackRows } : {})
      }
      const result = opts.recovery
        ? await this.client.requestRecoverySnapshot<GetSnapshotResult>(id, payload, opts.signal)
        : await this.client.request<GetSnapshotResult>(
            'getSnapshot',
            payload,
            undefined,
            opts.signal
          )
      if (!result) {
        return null
      }
      const snapshot = result.snapshot
      // Older v19 snapshots lack the absolute sequence needed to reconcile data queued on the other socket.
      if (!snapshot || typeof snapshot.outputSequence !== 'number') {
        return null
      }
      const explicitHistory =
        !opts.recovery &&
        scrollbackRows !== undefined &&
        scrollbackRows > DAEMON_SESSION_SCROLLBACK_ROWS
      if (explicitHistory) {
        const answer = await this.readSettledDurableHistory(id, snapshot, scrollbackRows, scope)
        const provider = this.toProviderBufferSnapshot(answer.snapshot)
        return provider
          ? { ...provider, ...(answer.historyLimited ? { historyLimited: true } : {}) }
          : null
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
    } finally {
      this.settledDurableHistory.end(id, scope)
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
      ...(snapshot.terminalOwner ? { terminalOwner: snapshot.terminalOwner } : {}),
      ...(snapshot.modes.synchronizedOutput ? { synchronizedOutput: true } : {})
    }
  }

  async clearBuffer(id: string): Promise<void> {
    this.markSessionDirty(id)
    await this.client.request('clearScrollback', { sessionId: id })
  }

  async resetInputModes(id: string): Promise<void> {
    this.markSessionDirty(id)
    await this.client.request('resetInputModes', { sessionId: id })
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
