import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalProducerLinkage,
  AgentJournalRowAttribution,
  AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  agentJournalLinkageFields,
  namesAgentJournalProducer
} from '../../../shared/agent-session-journal-producer'
import type { JournalLifecycleMutation } from './journal-row-schema'

export type JournalItemAddress =
  | { identity: AgentJournalItemIdentity; itemId?: never }
  | { itemId: string; identity?: never }

export type JournalLifecycleMutationInput = JournalItemAddress &
  (
    | {
        kind: 'item'
        body: AgentJournalItemBody
        /** Who wrote the row. Absent ⇒ the session's own agent on a first write,
         *  and the row's existing producer on a revision. */
        linkage?: AgentJournalProducerLinkage
        /** Which turn the row belongs to. Kept from the write that creates the row. */
        turnScope: AgentJournalTurnScope
      }
    | { kind: 'tombstone' }
  )

export type JournalLifecycleIdentityMutationInput = JournalLifecycleMutationInput & {
  identity: AgentJournalItemIdentity
}

export function journalLifecycleMutationItemId(mutation: JournalItemAddress): string {
  if (mutation.itemId !== undefined) {
    return mutation.itemId
  }
  return agentJournalItemKey(mutation.identity)
}

/** An item mutation from a writer that knows who produced the row. Needed
 *  because a batch can CREATE a row — a Codex child's prompt, or its item
 *  settled before any checkpoint landed — and one batch can mix producers.
 *  The session's own rows carry no key at all: absence is the claim. */
export function journalLifecycleItemMutation(
  attribution: AgentJournalRowAttribution,
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody
): JournalLifecycleIdentityMutationInput {
  const { turnScope } = attribution
  return namesAgentJournalProducer(attribution)
    ? { kind: 'item', identity, body, turnScope, linkage: agentJournalLinkageFields(attribution) }
    : { kind: 'item', identity, body, turnScope }
}

/** The persisted form of one mutation, shared with the partitioner's size probe
 *  so a chunk is measured with the linkage it will actually carry. */
export function journalLifecycleMutationRow(
  mutation: JournalLifecycleMutationInput,
  itemId: string,
  revision: number
): JournalLifecycleMutation {
  return mutation.kind === 'item'
    ? {
        kind: 'item',
        itemId,
        revision,
        body: mutation.body,
        turnScope: mutation.turnScope,
        ...agentJournalLinkageFields(mutation.linkage)
      }
    : { kind: 'tombstone', itemId, revision }
}
