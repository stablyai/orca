// How a provider's Stop, and a prompt card's own Cancel, end what they end. A chat's Stop ends the
// child for every provider; every member here is optional, and a card's Cancel with none interrupts
// the turn holding the card.

import type {
  AgentJournalApprovalItem,
  AgentJournalQuestionItem
} from '../../../shared/agent-session-journal-types'
import type { ProviderDiagnostic } from '../../../shared/agent-session-failure'

/** `refusal`: the provider answered the Stop and declined it, in its own words when it gave any.
 *  `turnNotRunning`: its refusal is the kind it gives for a turn not running there, so the Stop keeps
 *  the child; absent, it could not interrupt that turn, which may run on. `turnMayOpen`: no turn
 *  was there to interrupt, but one a send is owed may still open. `turnId`: the journal turn a Stop
 *  that took interrupted, which the Stop then binds. */
export type AgentSessionCancelOutcome = {
  cancelled: boolean
  refusal?: { detail?: ProviderDiagnostic; turnNotRunning?: true; turnMayOpen?: true }
  turnId?: string
}

/** Where a card's Cancel goes: a dismissal (`dismissPrompt`), or the chat's Stop. */
export type AgentSessionPromptCancelRoute = { kind: 'dismiss' } | { kind: 'stop' }

export type StructuredAgentSessionAdapterStop = {
  /** A chat's Stop ends every provider's child after `cancelTurn`, whatever it answered, unless it
   *  named a turn that is no longer live and the cancel answered that it did not take it; the next
   *  send resumes the conversation. This is what the Stop waits on before it ends the child: resolves once the provider
   *  has nothing in flight, a send it has not answered included, or when its grace, counted from
   *  `stoppedAt` (when the interrupt went out), runs out. */
  awaitStoppedRequestEnd?(sessionId: string, stoppedAt: number): Promise<void>
  /** Where the pending card's own Cancel goes. Undefined: `cancelTurn` with the prompt. */
  routePromptCancel?(input: {
    sessionId: string
    prompt: AgentJournalApprovalItem | AgentJournalQuestionItem
  }): AgentSessionPromptCancelRoute | undefined
  /** The user dismissed the pending card; `commit` records it as cancelled, with the claim held.
   *  `answer` then declines the provider's request; without it the request is left to end with the
   *  child a Stop ends. Either way the provider records nothing more for the card. */
  dismissPrompt?(input: {
    sessionId: string
    itemId: string
    fence: number
    answer: boolean
    commit: () => Promise<void>
  }): Promise<void>
}
