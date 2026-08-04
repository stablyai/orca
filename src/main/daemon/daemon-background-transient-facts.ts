/**
 * Daemon-side transient-fact scanning for backgrounded sessions.
 *
 * While a session is backgrounded (its pane hidden in the renderer), the
 * daemon→main stream copy may be keep-tail thinned under backlog — but the
 * notification-bearing facts inside those bytes must never be lost. This
 * relay runs the SAME shared scanners main uses (terminal-side-effect
 * authority doc: semantics must not drift) over every raw chunk BEFORE any
 * drop decision, and emits compact transientFact stream events in byte order.
 * Main suppresses its own copies of these four scanners between the
 * sessionBackgroundMarker handoffs, so no fact double-fires or goes missing.
 *
 * Title/agent-status facts are deliberately NOT relayed: they converge from
 * the delivered kept tail (stale-working-title timer, snapshot-restores-title
 * -state) and main fuses them with synthetic spinner frames the daemon never
 * sees.
 */
import {
  createTerminalTitleTracker,
  type TerminalTitleTracker
} from '../../shared/terminal-output-side-effects'
import {
  INITIAL_MODE_2031_REPLY_SCAN_STATE,
  scanMode2031ReplyDecision,
  type Mode2031ReplyScanState
} from '../../shared/terminal-color-scheme-protocol'
import type { DaemonTransientFact } from './types'

// Kill switch for the whole background keep-tail mechanism (thinning +
// daemon-side fact authority): ORCA_DAEMON_BACKGROUND_STREAM_DROP=0.
export const BACKGROUND_STREAM_DROP_ENABLED = process.env.ORCA_DAEMON_BACKGROUND_STREAM_DROP !== '0'

export class BackgroundTransientFactRelay {
  private trackersBySessionId = new Map<string, TerminalTitleTracker>()
  // Why: shadow foreground bytes so a provisional subscribe survives either scan-authority handoff.
  private mode2031ReplyScanStateBySessionId = new Map<string, Mode2031ReplyScanState>()
  private emitFact: (sessionId: string, fact: DaemonTransientFact) => void

  constructor(emitFact: (sessionId: string, fact: DaemonTransientFact) => void) {
    this.emitFact = emitFact
  }

  isBackgrounded(sessionId: string): boolean {
    return this.trackersBySessionId.has(sessionId)
  }

  backgroundedSessionIdSuffixes(): string[] {
    return Array.from(this.trackersBySessionId.keys(), (id) => id.slice(-10))
  }

  /** Returns false when this was a no-op (already in the requested state) so
   *  the caller can skip a duplicate handoff marker — resyncs after adoption
   *  re-send the whole background set. */
  setSessionBackground(sessionId: string, background: boolean): boolean {
    if (background === this.isBackgrounded(sessionId)) {
      return false
    }
    if (background) {
      this.trackersBySessionId.set(
        sessionId,
        createTerminalTitleTracker({
          onBell: () => this.emitFact(sessionId, { kind: 'bell' }),
          onCommandFinished: (exitCode) =>
            this.emitFact(sessionId, { kind: 'command-finished', exitCode }),
          // Note: recreating the tracker on each background toggle resets the
          // PR-link dedup memory, so a link re-printed across toggles can
          // re-fire — consumers treat pr-link as a latest-association update.
          onPrLink: (link) => this.emitFact(sessionId, { kind: 'pr-link', link }),
          onMode2031Subscribe: () => this.emitFact(sessionId, { kind: '2031-subscribe' }),
          onMode2031Unsubscribe: () => this.emitFact(sessionId, { kind: '2031-unsubscribe' })
        })
      )
    } else {
      this.disposeTracker(sessionId)
    }
    return true
  }

  /** Prime a fresh tracker's cross-chunk carry with the emulator's dangling
   *  incomplete escape at handoff time, so a sequence split across the
   *  background toggle neither mints a phantom bell nor loses its fact. A
   *  partial tail contains no complete sequence, so this can never fire. */
  seedSessionScanState(sessionId: string, partialEscapeTailAnsi: string): void {
    let mode2031State = this.mode2031ReplyScanStateBySessionId.get(sessionId)
    if (!mode2031State && partialEscapeTailAnsi.length > 0) {
      mode2031State = scanMode2031ReplyDecision(
        INITIAL_MODE_2031_REPLY_SCAN_STATE,
        partialEscapeTailAnsi
      ).state
      if (mode2031State.tail.length > 0) {
        this.mode2031ReplyScanStateBySessionId.set(sessionId, mode2031State)
      }
    }
    mode2031State ??= INITIAL_MODE_2031_REPLY_SCAN_STATE
    const scanSeedAnsi = mode2031State.tail || partialEscapeTailAnsi
    if (scanSeedAnsi.length > 0) {
      this.trackersBySessionId.get(sessionId)?.handleChunk(scanSeedAnsi, {
        titleScanData: '',
        mode2031PendingSubscribe: mode2031State.pendingSubscribe
      })
    }
  }

  /** Feed one raw chunk, in byte order, BEFORE it is enqueued for delivery —
   *  facts must be captured even when the chunk is later keep-tail dropped. */
  onSessionData(sessionId: string, data: string): void {
    const previousMode2031State = this.mode2031ReplyScanStateBySessionId.get(sessionId)
    if (previousMode2031State || data.includes('\x1b') || data.includes('\x9b')) {
      const mode2031Result = scanMode2031ReplyDecision(
        previousMode2031State ?? INITIAL_MODE_2031_REPLY_SCAN_STATE,
        data
      )
      if (mode2031Result.state.tail.length > 0 || mode2031Result.state.pendingSubscribe) {
        this.mode2031ReplyScanStateBySessionId.set(sessionId, mode2031Result.state)
      } else {
        this.mode2031ReplyScanStateBySessionId.delete(sessionId)
      }
    }
    // titleScanData:'' skips title extraction (titles stay main-authoritative)
    // and keeps the stale-working-title timer permanently unarmed — only the
    // four transient scanners consume the chunk.
    this.trackersBySessionId.get(sessionId)?.handleChunk(data, { titleScanData: '' })
  }

  getMode2031ReplyScanState(sessionId: string): Mode2031ReplyScanState {
    return (
      this.mode2031ReplyScanStateBySessionId.get(sessionId) ?? INITIAL_MODE_2031_REPLY_SCAN_STATE
    )
  }

  onSessionExit(sessionId: string): void {
    this.disposeTracker(sessionId)
    this.mode2031ReplyScanStateBySessionId.delete(sessionId)
  }

  dispose(): void {
    for (const sessionId of Array.from(this.trackersBySessionId.keys())) {
      this.disposeTracker(sessionId)
    }
    this.mode2031ReplyScanStateBySessionId.clear()
  }

  private disposeTracker(sessionId: string): void {
    this.trackersBySessionId.get(sessionId)?.dispose()
    this.trackersBySessionId.delete(sessionId)
  }
}
