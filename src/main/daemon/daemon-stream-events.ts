import type { TerminalGitHubPRLink } from '../../shared/terminal-github-pr-link-detector'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'

export type DataEvent = {
  type: 'event'
  event: 'data'
  sessionId: string
  payload: {
    data: string
    seq?: number
    rawLength?: number
    transformed?: boolean
    /** Legacy v23 name retained for old adapter fixtures. */
    sequenceChars?: number
  }
}

export type ExitEvent = {
  type: 'event'
  event: 'exit'
  sessionId: string
  /** Older daemons omit cause; treat it as unknown instead of inferring a cause from the exit code (STA-4536). */
  payload: { code: number; incarnationId?: PtyIncarnationId; cause?: TerminalExitCause }
}

export type TerminalErrorEvent = {
  type: 'event'
  event: 'terminalError'
  sessionId: string
  payload: { message: string }
}

// Handoffs and gaps must share byte-stream order; older mains tolerate unknown events.

/** Transfer scan authority at this stream position, including incomplete escapes and deferred subscriptions. */
export type SessionBackgroundMarkerEvent = {
  type: 'event'
  event: 'sessionBackgroundMarker'
  sessionId: string
  payload: {
    background: boolean
    scanSeedAnsi?: string
    mode2031PendingSubscribe?: true
  }
}

/** Only the monitoring stream loses bytes; the daemon emulator retains the complete terminal model. */
export type DataGapEvent = {
  type: 'event'
  event: 'dataGap'
  sessionId: string
  payload: { droppedChars: number; sequenceChars?: number }
}

/** Daemon-authoritative notifications; main retains title/status scanning to include its synthetic frames. */
export type DaemonTransientFact =
  | { kind: 'bell' }
  | { kind: 'command-finished'; exitCode: number | null }
  | { kind: 'pr-link'; link: TerminalGitHubPRLink }
  | { kind: '2031-subscribe' }
  | { kind: '2031-unsubscribe' }

export type TransientFactEvent = {
  type: 'event'
  event: 'transientFact'
  sessionId: string
  payload: DaemonTransientFact
}

export type DaemonEvent =
  | DataEvent
  | ExitEvent
  | TerminalErrorEvent
  | SessionBackgroundMarkerEvent
  | DataGapEvent
  | TransientFactEvent
