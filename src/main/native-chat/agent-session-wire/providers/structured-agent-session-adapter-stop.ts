// Chat Stop ends the captured child for every provider; default prompt Cancel interrupts its turn.

import type {
  AgentChildWorkStopAcknowledgement,
  AgentSessionBackgroundTaskStops
} from '../../../../shared/agent-status/child-work/agent-child-work-stop-targets'
import type {
  AgentJournalApprovalItem,
  AgentJournalDispatchState,
  AgentJournalQuestionItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { ProviderDiagnostic } from '../../../../shared/agent-session/failures/agent-session-failure'

export type AgentSessionCloseEvidence = {
  root?: 'live' | 'unverifiable' | 'exited'
  workload?: 'live' | 'unverifiable' | 'exited'
  deathEvidenceKind?: 'kill-delivered'
}
export type AgentSessionCloseObserver = (evidence: AgentSessionCloseEvidence | undefined) => void

/** In-process completion evidence is separate from durable command acceptance. */
export type AgentSessionStopOutcome = {
  /** Read/pause acknowledgement, not universal durable-write quiescence. */
  pause: 'acknowledged' | 'not-needed' | 'unconfirmed'
  interrupt: 'accepted' | 'not-needed' | 'unconfirmed'
  root: 'exited' | 'unproven'
  workload: 'exited' | 'unproven'
  deathEvidenceKind?: 'kill-delivered'
  errors: unknown[]
}

/** Distinguish refused interrupts, absent turns with possible pending openers, and the journal turn actually stopped. */
export type AgentSessionCancelOutcome = {
  cancelled: boolean
  stop?: AgentSessionStopOutcome
  refusal?: { detail?: ProviderDiagnostic; turnNotRunning?: true; turnMayOpen?: true }
  turnId?: string
}

export type AgentSessionPromptCancelRoute = { kind: 'dismiss' } | { kind: 'stop' }

/** See `StructuredAgentSessionAdapter.keptLaunchOutgrown`. */
type KeptLaunchOutgrownAnswer = boolean | 'pending' | undefined
type KeptLaunchOutgrown = KeptLaunchOutgrownAnswer | Promise<KeptLaunchOutgrownAnswer>

export type StructuredAgentSessionAdapterStop = {
  /** Stop named tasks only; acknowledge each accepted stop immediately so later batch failures cannot erase it. */
  stopBackgroundTasks?(input: {
    sessionId: string
    fence: number
    taskIds: readonly string[]
    acknowledge?: (acknowledgement: AgentChildWorkStopAcknowledgement) => void
  }): Promise<{ cancelled: boolean; stillRunning?: true }>
  /** Undefined when no live session exposes stop support. */
  backgroundTaskStops?(sessionId: string): AgentSessionBackgroundTaskStops | undefined
  /** Cancel only the requested turn; absent turnId also covers dispatches whose turns have not opened. */
  cancelTurn(input: {
    sessionId: string
    turnId?: string
    fence: number
    prompt?: { itemId: string }
    /** Original host Stop time; in-process only, for a Stop that ends the session. */
    stoppedAt?: number
    dispatchStatus?: { state: AgentJournalDispatchState; recovered: boolean } | null
    /** Re-read journal turn immediately before interrupt; direct callers may omit this guard. */
    resolveLiveTurnId?: () => Promise<string | null>
  }): Promise<AgentSessionCancelOutcome>
  /** Wait for in-flight work or grace expiry measured from interrupt issuance. */
  awaitStoppedRequestEnd?(sessionId: string, stoppedAt: number): Promise<void>
  /** Undefined routes through cancelTurn with the prompt. */
  routePromptCancel?(input: {
    sessionId: string
    prompt: AgentJournalApprovalItem | AgentJournalQuestionItem
  }): AgentSessionPromptCancelRoute | undefined
  /** Claim and commit dismissal before optional provider reply; Cancel/answer must share the claim. */
  dismissPrompt?(input: {
    sessionId: string
    itemId: string
    fence: number
    answer: boolean
    commit: () => Promise<void>
  }): Promise<void>
  /** Open work, keyed as the provider's relay work markers key it, for a detached idle stop. */
  relayOpenWork?(sessionId: string, rootTurnRunning: boolean): Record<string, string[][]> | null
  /** A kept agent the chat reattached: true when it lacks the tools its launch has and ending it
   *  loses no replayed output (the next new turn starts a child that has them); 'pending' when it
   *  lacks them but its replay isn't durable yet (the send neither reaches it nor ends it); false
   *  when no tools refresh may end it (it owes work, its replay isn't durable, or its work can't be
   *  seen); undefined with nothing to protect. Only when a refresh could follow (it lacks tools, or
   *  `toolsOutdated`, the host's `launchTools.outdated`) does it ask `owesWork`, then may wait for
   *  its replay's last ack, so the send that follows reaches the fresh agent. */
  keptLaunchOutgrown?(
    sessionId: string,
    toolsOutdated: boolean,
    owesWork: () => Promise<boolean>
  ): KeptLaunchOutgrown
}
