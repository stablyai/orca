// ─── Events (Daemon → Client, on stream socket) ────────────────────
import type { TerminalGitHubPRLink } from '../../shared/terminal-github-pr-link-detector'

export type DataEvent = {
  type: 'event'
  event: 'data'
  sessionId: string
  payload: { data: string; sequenceChars?: number }
}

export type ExitEvent = {
  type: 'event'
  event: 'exit'
  sessionId: string
  payload: { code: number }
}

export type TerminalErrorEvent = {
  type: 'event'
  event: 'terminalError'
  sessionId: string
  payload: { message: string }
}

// Why these ride the stream socket (not control): each marks a POSITION in a
// session's byte stream — scan-authority handoffs and dropped ranges are only
// meaningful relative to the data events around them. Old mains ignore
// unknown stream events, and only new mains send setSessionBackground. The
// v20 bump is for sequence-safe recovery snapshots, not these tolerated events.

/** Scan-authority handoff marker: bytes before this event were (not) scanned
 *  by the daemon's transient-fact relay; main flips its own scanners at
 *  exactly this position so no fact double-fires or goes missing.
 *  scanSeedAnsi (un-background only) carries the emulator's dangling
 *  incomplete escape so main can prime its fresh scanner carry — a sequence
 *  split across the handoff must not mint a phantom bell or lose its fact. */
export type SessionBackgroundMarkerEvent = {
  type: 'event'
  event: 'sessionBackgroundMarker'
  sessionId: string
  payload: { background: boolean; scanSeedAnsi?: string }
}

/** A backgrounded session's oldest undelivered output was dropped at the
 *  daemon (keep-tail thinning). The daemon emulator ingested every byte —
 *  only this monitoring stream is thinned. */
export type DataGapEvent = {
  type: 'event'
  event: 'dataGap'
  sessionId: string
  payload: { droppedChars: number; sequenceChars?: number }
}

/** Notification-bearing fact detected by the daemon while it holds scan
 *  authority for a backgrounded session. Title/agent-status facts stay
 *  main-side: they converge from the kept tail (stale-working-title timer,
 *  snapshot-restores-title-state) and fuse with main-fabricated synthetic
 *  frames the daemon never sees. */
export type DaemonTransientFact =
  | { kind: 'bell' }
  | { kind: 'command-finished'; exitCode: number | null }
  | { kind: 'pr-link'; link: TerminalGitHubPRLink }
  | { kind: '2031-subscribe' }

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
