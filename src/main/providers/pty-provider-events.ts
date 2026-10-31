import type { TerminalGitHubPRLink } from '../../shared/terminal-github-pr-link-detector'
import type { TerminalTransientObservation } from '../../shared/terminal-transient-observation'

export type PtySemanticSource = { provider: object; stream: object; terminalState: boolean }

export type PtyDataEvent = {
  semanticSource?: PtySemanticSource
  id: string
  data: string
  sequenceChars?: number
  transformed?: boolean
  seq?: number
  /** The emitting provider already fed this chunk to the runtime through configure().onData. */
  runtimeFed?: true
}

/** Notification fact observed while the thinning transport owned scan authority for this PTY. */
export type PtyTransientFact =
  | { kind: 'command-started' }
  | { kind: 'bell' }
  | { kind: 'command-finished'; exitCode: number | null }
  | { kind: 'pr-link'; link: TerminalGitHubPRLink }
  | { kind: '2031-subscribe' }
  | { kind: '2031-unsubscribe' }

export type PtyBackgroundStreamEvent =
  | {
      id: string
      kind: 'terminalObservation'
      semanticSource?: PtySemanticSource
      incarnationId: string
      observation: TerminalTransientObservation
    }
  | {
      id: string
      kind: 'backgroundMarker'
      semanticSource?: PtySemanticSource
      background: boolean
      scanSeedAnsi?: string
      mode2031PendingSubscribe?: true
    }
  | { id: string; kind: 'dataGap'; droppedChars: number; sequenceChars?: number }
  | { id: string; kind: 'transientFact'; fact: PtyTransientFact }
