// Default Stop keeps successfully interrupted children; default prompt Cancel interrupts their turn.

import type {
  AgentJournalApprovalItem,
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
  /** Opt into child termination after Stop; stale-target refusals keep it, failed interrupts of live targets end it. */
  stopEndsSession?(sessionId: string): boolean
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
