import { journalItemEchoFields, type JournalItemEcho } from './journal-item-echo'
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
        echoOf?: unknown
        body: AgentJournalItemBody
        observedAt?: number
        /** Absent means root on creation, existing producer on revision. */
        linkage?: AgentJournalProducerLinkage
        turnScope: AgentJournalTurnScope
        ownerFence?: number
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

/** Batches can create rows from mixed producers; absent linkage explicitly means the session agent. */
export function journalLifecycleItemMutation(
  attribution: AgentJournalRowAttribution & JournalItemEcho & { observedAt?: number },
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody
): Extract<JournalLifecycleIdentityMutationInput, { kind: 'item' }> {
  const { turnScope } = attribution
  return {
    kind: 'item',
    identity,
    body,
    turnScope,
    ...(attribution.observedAt === undefined ? {} : { observedAt: attribution.observedAt }),
    ...journalItemEchoFields(attribution),
    ...(namesAgentJournalProducer(attribution)
      ? { linkage: agentJournalLinkageFields(attribution) }
      : {})
  }
}

/** Use identical persisted linkage when measuring and writing mutations. */
export function journalLifecycleMutationRow(
  mutation: JournalLifecycleMutationInput,
  itemId: string,
  revision: number,
  ownerFence: number
): JournalLifecycleMutation {
  return mutation.kind === 'item'
    ? {
        kind: 'item',
        itemId,
        revision,
        body: mutation.body,
        ...(mutation.observedAt === undefined ? {} : { observedAt: mutation.observedAt }),
        ...journalItemEchoFields(mutation),
        turnScope: mutation.turnScope,
        ownerFence,
        ...agentJournalLinkageFields(mutation.linkage)
      }
    : { kind: 'tombstone', itemId, revision }
}
