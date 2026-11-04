import { journalExecutionAddress, journalExecutionOriginForItem } from './journal-execution-item'
import { journalWriteTurnScope } from './journal-write-turn-scope'
import { journalItemExecutionFence, journalItemOwnerFence } from './journal-item-provenance'
import { nextJournalItemRevision } from './journal-item-revision'
import { turnEndAfterStop } from './journal-stop-turn-end'
import type { JournalReducerState } from './journal-reducer'
import { journalItemEchoFields, type JournalItemEcho } from './journal-item-echo'
import type {
  AgentJournalItemBody,
  AgentJournalProducerLinkage,
  AgentJournalRowAttribution
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  agentJournalLinkageFields,
  namesAgentJournalProducer
} from '../../../shared/agent-session/journal/agent-session-journal-producer'
import type { JournalExecutionOrigin } from './journal-execution-item'
import type { JournalLifecycleMutation } from './journal-row-schema'
import { boundRunningToolOutput } from './journal-payload-bounds'

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
        executionOwner?: number
        executionOrigin?: JournalExecutionOrigin
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
        ...(mutation.executionOrigin ? { executionOrigin: mutation.executionOrigin } : {}),
        itemId,
        revision,
        body: boundRunningToolOutput(mutation.body),
        ...(mutation.observedAt === undefined ? {} : { observedAt: mutation.observedAt }),
        ...journalItemEchoFields(mutation),
        turnScope: mutation.turnScope,
        ownerFence,
        ...(mutation.executionOwner === undefined
          ? {}
          : { executionOwner: mutation.executionOwner }),
        ...agentJournalLinkageFields(mutation.linkage)
      }
    : { kind: 'tombstone', itemId, revision }
}

export function journalLifecycleMutationForState(
  state: JournalReducerState,
  mutation: JournalLifecycleMutationInput,
  fence: number,
  revisions: Map<string, number>
): JournalLifecycleMutation {
  const itemId = journalLifecycleMutationItemId(mutation)
  const address =
    mutation.kind === 'item'
      ? journalExecutionAddress(
          state,
          itemId,
          mutation.body,
          {
            fence,
            ownerFence: mutation.ownerFence,
            executionOwner: mutation.executionOwner
          },
          mutation.itemId !== undefined
        )
      : undefined
  const resolved =
    address?.itemId ??
    (mutation.itemId !== undefined && state.items.has(itemId)
      ? itemId
      : (state.aliases.get(itemId) ?? itemId))
  const revision = nextJournalItemRevision(state, resolved, revisions)
  const ownerFence = journalItemOwnerFence(state, resolved, {
    fence,
    ownerFence: mutation.kind === 'item' ? mutation.ownerFence : undefined
  })
  return journalLifecycleMutationRow(
    mutation.kind === 'item'
      ? {
          ...mutation,
          turnScope: journalWriteTurnScope(
            state,
            mutation.turnScope,
            mutation.executionOwner ?? mutation.ownerFence ?? fence,
            mutation.itemId !== undefined
          ),
          ...(mutation.itemId === undefined
            ? {}
            : { executionOrigin: journalExecutionOriginForItem(state, itemId) }),
          body:
            address?.itemId === undefined
              ? mutation.body
              : turnEndAfterStop(
                  state,
                  resolved,
                  mutation.body,
                  journalItemExecutionFence(state, resolved) ?? ownerFence
                )
        }
      : mutation,
    mutation.kind === 'tombstone' ? resolved : itemId,
    revision,
    ownerFence
  )
}
