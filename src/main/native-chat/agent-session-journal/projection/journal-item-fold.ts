import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { parseAgentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  agentJournalLinkageFields,
  isRootAgentJournalItem,
  namesAgentJournalProducer
} from '../../../../shared/agent-session/journal/agent-session-journal-producer'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type { JournalReducerState } from './journal-reducer'

export function statedOrDerivedTurnScope(
  state: JournalReducerState,
  write: { body: AgentJournalItemBody; turnScope?: AgentJournalTurnScope }
): AgentJournalTurnScope {
  return write.turnScope ?? state.derivedTurnScope.scopeFor(write.body)
}

export function upsertJournalItem(
  state: JournalReducerState,
  itemId: string,
  revision: number,
  next: AgentJournalRenderItem,
  /** Creation fixes ownerFence; revisions retain it, while explicit executionOwner may change. */
  fences: { fence: number; ownerFence?: number; executionOwner?: number }
): void {
  const tombstoned = state.tombstones.get(itemId)
  if (tombstoned !== undefined && revision <= tombstoned) {
    return
  }
  const existing = state.items.get(itemId)
  if (existing && revision <= existing.revision) {
    return
  }
  state.derivedTurnScope.observe(itemId, isRootAgentJournalItem(next), existing?.body, next.body)
  if (fences.executionOwner !== undefined) {
    state.itemExecutionOwners.set(itemId, fences.executionOwner)
  }
  if (!existing) {
    state.items.set(itemId, next)
    state.itemFences.set(itemId, fences.ownerFence ?? fences.fence)
    state.tombstones.delete(itemId)
    return
  }
  state.items.set(itemId, journalItemRevisionValue(existing, next))
  state.tombstones.delete(itemId)
}

/** Revisions preserve the current placement, including a handover or rejection's later move. */
export function journalItemRevisionValue(
  existing: AgentJournalRenderItem,
  next: AgentJournalRenderItem
): AgentJournalRenderItem {
  const submitted =
    existing.body.kind === 'message' &&
    existing.body.role === 'user' &&
    parseAgentJournalItemKey(existing.itemId)?.provider === 'orca'
  const { sequenceIndex: _revisedAt, ...revised } = next
  return {
    ...revised,
    ...(namesAgentJournalProducer(next) ? {} : agentJournalLinkageFields(existing)),
    body: submitted ? existing.body : next.body,
    sequence: existing.sequence,
    ...(existing.sequenceIndex !== undefined ? { sequenceIndex: existing.sequenceIndex } : {}),
    observedAt: existing.observedAt,
    turnScope: existing.turnScope ?? next.turnScope
  }
}

export function removeJournalItem(
  state: JournalReducerState,
  itemId: string,
  revision: number
): void {
  const existing = state.items.get(itemId)
  if (existing && revision <= existing.revision) {
    return
  }
  const tombstoned = state.tombstones.get(itemId)
  if (tombstoned !== undefined && revision <= tombstoned) {
    return
  }
  if (existing) {
    state.derivedTurnScope.observe(
      itemId,
      isRootAgentJournalItem(existing),
      existing.body,
      undefined
    )
    const turnId = readAgentJournalTurn(existing.body)?.turnId
    if (turnId !== undefined) {
      state.removedTurnIds.add(turnId)
    }
  }
  state.tombstones.set(itemId, revision)
  state.items.delete(itemId)
  state.itemFences.delete(itemId)
  state.itemExecutionOwners.delete(itemId)
}
