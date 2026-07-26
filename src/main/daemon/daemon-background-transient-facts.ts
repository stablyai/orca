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
import type { DaemonTransientFact } from './types'

// Kill switch for the whole background keep-tail mechanism (thinning +
// daemon-side fact authority): ORCA_DAEMON_BACKGROUND_STREAM_DROP=0.
export const BACKGROUND_STREAM_DROP_ENABLED = process.env.ORCA_DAEMON_BACKGROUND_STREAM_DROP !== '0'

export class BackgroundTransientFactRelay {
  private trackersBySessionId = new Map<string, TerminalTitleTracker>()
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
          onMode2031Subscribe: () => this.emitFact(sessionId, { kind: '2031-subscribe' })
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
    if (partialEscapeTailAnsi.length > 0) {
      this.trackersBySessionId
        .get(sessionId)
        ?.handleChunk(partialEscapeTailAnsi, { titleScanData: '' })
    }
  }

  /** Feed one raw chunk, in byte order, BEFORE it is enqueued for delivery —
   *  facts must be captured even when the chunk is later keep-tail dropped. */
  onSessionData(sessionId: string, data: string): void {
    // titleScanData:'' skips title extraction (titles stay main-authoritative)
    // and keeps the stale-working-title timer permanently unarmed — only the
    // four transient scanners consume the chunk.
    this.trackersBySessionId.get(sessionId)?.handleChunk(data, { titleScanData: '' })
  }

  onSessionExit(sessionId: string): void {
    this.disposeTracker(sessionId)
  }

  dispose(): void {
    for (const sessionId of Array.from(this.trackersBySessionId.keys())) {
      this.disposeTracker(sessionId)
    }
  }

  private disposeTracker(sessionId: string): void {
    this.trackersBySessionId.get(sessionId)?.dispose()
    this.trackersBySessionId.delete(sessionId)
  }
}
