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
  /** Derive absent legacy scopes from timeline position before persisting them. */
  turnScope?: AgentJournalTurnScope
  /** Preserve original execution provenance; history replacement is not new work. */
  ownerFence: number
  executionOwner?: number
}
