// Scan raw bytes before background thinning; handoff markers keep main from emitting duplicate facts.
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

export const BACKGROUND_STREAM_DROP_ENABLED = process.env.ORCA_DAEMON_BACKGROUND_STREAM_DROP !== '0'

export class BackgroundTransientFactRelay {
  private trackersBySessionId = new Map<string, TerminalTitleTracker>()
  // Shadow foreground bytes so provisional subscriptions survive either scan-authority handoff.
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

  /** Return false for unchanged state so adoption resyncs do not emit duplicate handoff markers. */
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
          // Background toggles reset PR-link dedupe; consumers accept links as association updates.
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

  /** Seed incomplete escapes at handoff so split sequences neither lose facts nor emit phantom bells. */
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

  /** Scan in byte order before enqueueing: later thinning may discard the raw chunk. */
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
    // Keep titles and their stale timers main-authoritative; scan transient facts only.
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
