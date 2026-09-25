import type { TerminalGitHubPRLink } from '../../shared/terminal-github-pr-link-detector'

export type PtyDataEvent = {
  id: string
  data: string
  sequenceChars?: number
  transformed?: boolean
  seq?: number
  /** Observed source; does not admit or replace the provider binding. */
  incarnationId?: string
}

/** Notification-bearing fact a thinning transport detected while it held
 *  scan authority for a backgrounded PTY (see onBackgroundStreamEvent). */
export type PtyTransientFact =
  | { kind: 'bell' }
  | { kind: 'command-finished'; exitCode: number | null }
  | { kind: 'pr-link'; link: TerminalGitHubPRLink }
  | { kind: '2031-subscribe' }
  | { kind: '2031-unsubscribe' }

export type PtyBackgroundStreamEvent = { incarnationId?: string } & (
  | {
      id: string
      kind: 'backgroundMarker'
      background: boolean
      scanSeedAnsi?: string
      mode2031PendingSubscribe?: true
    }
  | { id: string; kind: 'dataGap'; droppedChars: number; sequenceChars?: number }
  | { id: string; kind: 'transientFact'; fact: PtyTransientFact }
)
