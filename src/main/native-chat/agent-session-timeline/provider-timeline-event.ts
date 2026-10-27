// Adapters provide stable provider keys; the assembler owns journal identities and lifecycle rules.
// Only turn.open creates turns. Rejected admission changes nothing: retry backpressure, not failed/closed.
// Settled rows never regress; external Stop cancels text/prompts but leaves calls for provider settlement.
// Each provider child gets a new generation; session.ended rejects all later events.

import type { AgentSessionContextUsage } from '../../../shared/agent-session-context-usage'
import type {
  AgentJournalApprovalItem,
  AgentJournalItemBody,
  AgentJournalProducerLinkage,
  AgentJournalQuestionItem,
  AgentJournalTurnOutcome
} from '../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionTurnVerdict } from '../agent-session-wire/structured-agent-session-stale-turn-verdict'

/** The assembler owns turn rows; prompts travel as requests. */
export type ProviderTimelineItemBody = Exclude<
  AgentJournalItemBody,
  { kind: 'turn' | 'approval' | 'question' }
>

export type ProviderTimelineRequestBody = AgentJournalApprovalItem | AgentJournalQuestionItem

export type ProviderTimelineTextChannel = 'assistant' | 'reasoning'

export type ProviderTimelineJoin = {
  thread?: string
  /** Absent uses the open turn. */
  turn?: string
}

/** Named items share full-snapshot rows; anonymous streams create a message each time they start. */
export type ProviderTimelineTextItem = { id: string } | { stream: string }

type Produced = {
  producer?: AgentJournalProducerLinkage
}

type Joined = { join?: ProviderTimelineJoin }

export type ProviderTimelineEvent =
  /** Bind the send to an unclaimed open turn, otherwise the next; join.turn names its opener. */
  | {
      type: 'input.accepted'
      clientMessageId: string
      requestedAt: number
      join?: ProviderTimelineJoin
    }
  /** Mint a turn ID only when the provider supplies none. */
  | { type: 'turn.open'; turn?: string; at: number }
  /** Settle residual work even for ended turns; preserve their verdict and newer turns’ text/activity. */
  | {
      type: 'turn.end'
      turn?: string
      at: number
      state: 'completed' | 'interrupted'
      /** Absent provider verdict remains unknown. */
      outcome?: AgentJournalTurnOutcome
      durationMs?: number
    }
  /** Background-task messages outlive their initiating call/turn and become unverifiable on session end. */
  | ({ type: 'item.open'; item: string; body: ProviderTimelineItemBody } & Produced & Joined)
  /** Full snapshot; settled tools retain terminal bodies. */
  | ({ type: 'item.update'; item: string; body: ProviderTimelineItemBody } & Produced & Joined)
  /** Terminal snapshot replaces text streamed under the same item ID. */
  | ({ type: 'item.close'; item: string; body: ProviderTimelineItemBody } & Produced & Joined)
  | ({
      type: 'text.delta'
      item: ProviderTimelineTextItem
      channel: ProviderTimelineTextChannel
      text: string
    } & Produced &
      Joined)
  /** Final text overrides accumulated deltas; join must match the same item. */
  | ({ type: 'text.close'; item: ProviderTimelineTextItem; text?: string } & Joined)
  | ({ type: 'request.open'; request: string; body: ProviderTimelineRequestBody } & Produced &
      Joined)
  /** Withdraw only unanswered requests. */
  | { type: 'request.withdrawn'; request: string }
  /** Use the named turn, otherwise open turn, otherwise last turn. */
  | ({ type: 'context.usage'; usage: AgentSessionContextUsage } & Joined)
  | { type: 'activity'; text: string | null }
  /** Unmodeled traffic uses the bounded fallback row. */
  | ({ type: 'provider.frame'; frameKind: string; payload: unknown } & Joined)
  /** Record only host-provable session-end outcomes. */
  | {
      type: 'session.ended'
      verdict: StructuredAgentSessionTurnVerdict
      /** Contact-loss time for work still running. */
      endedAt?: number
    }
