import type { TerminalGitHubPRLink } from '../../shared/terminal-github-pr-link-detector'

export type PtyDataEvent = {
  id: string
  data: string
  sequenceChars?: number
  transformed?: boolean
  seq?: number
}

/** Notification-bearing fact a thinning transport detected while it held
 *  scan authority for a backgrounded PTY (see onBackgroundStreamEvent). */
export type PtyTransientFact =
  | { kind: 'bell' }
  | { kind: 'command-finished'; exitCode: number | null }
  | { kind: 'pr-link'; link: TerminalGitHubPRLink }
  | { kind: '2031-subscribe' }

export type PtyBackgroundStreamEvent =
  | { id: string; kind: 'backgroundMarker'; background: boolean; scanSeedAnsi?: string }
  | { id: string; kind: 'dataGap'; droppedChars: number; sequenceChars?: number }
  | { id: string; kind: 'transientFact'; fact: PtyTransientFact }
