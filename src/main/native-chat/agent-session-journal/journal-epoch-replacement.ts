import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalProducerLinkage,
  AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import type { JournalItemEcho } from './journal-item-echo'

export type JournalReplacementItem = AgentJournalProducerLinkage & {
  echoOf?: JournalItemEcho['echoOf']
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  observedAt?: number
  /** Absent for history rebuilt from a source that never stated one: derived from position, as
   *  a legacy row's is, and then written down. */
  turnScope?: AgentJournalTurnScope
  /** Carried from the epoch it came from (`JournalItemRow.ownerFence`), never the replacing
   *  writer's fence: replacing history does not make it the current generation's work. */
  ownerFence: number
  /** Carried the same way (`JournalItemRow.executionOwner`). */
  executionOwner?: number
}
