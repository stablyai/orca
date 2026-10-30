import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  agentJournalLinkageFields,
  isRootAgentJournalItem,
  namesAgentJournalProducer
} from '../../../shared/agent-session-journal-producer'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
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
  // Pin creation position/time so provider echoes cannot move submitted bubbles below later messages.
  const submitted =
    existing.body.kind === 'message' &&
    existing.body.role === 'user' &&
    parseAgentJournalItemKey(itemId)?.provider === 'orca'
  const { sequenceIndex: _revisedAt, ...revised } = next
  state.items.set(itemId, {
    ...revised,
    // Host bookkeeping without explicit producer must retain subagent linkage.
    ...(namesAgentJournalProducer(next) ? {} : agentJournalLinkageFields(existing)),
    // Provider history may normalize text or omit local attachments from the original send.
    body: submitted ? existing.body : next.body,
    sequence: existing.sequence,
    ...(existing.sequenceIndex !== undefined ? { sequenceIndex: existing.sequenceIndex } : {}),
    observedAt: existing.observedAt,
    turnScope: existing.turnScope ?? next.turnScope
  })
  state.tombstones.delete(itemId)
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
