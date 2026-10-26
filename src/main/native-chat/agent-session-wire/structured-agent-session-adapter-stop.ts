// Chat Stop ends the captured child for every provider; default prompt Cancel interrupts its turn.

import type {
  AgentChildWorkStopAcknowledgement,
  AgentSessionBackgroundTaskStops
} from '../../../shared/agent-child-work-stop-targets'
import type {
  AgentJournalApprovalItem,
  AgentJournalDispatchState,
  AgentJournalQuestionItem
} from '../../../shared/agent-session-journal-types'
import type { ProviderDiagnostic } from '../../../shared/agent-session-failure'

/** Distinguish refused interrupts, absent turns with possible pending openers, and the journal turn actually stopped. */
export type AgentSessionCancelOutcome = {
  cancelled: boolean
  refusal?: { detail?: ProviderDiagnostic; turnNotRunning?: true; turnMayOpen?: true }
  turnId?: string
}

export type AgentSessionPromptCancelRoute = { kind: 'dismiss' } | { kind: 'stop' }

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
    resolveLiveTurnId?: () => string | null
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
}
