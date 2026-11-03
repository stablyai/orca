import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  agentJournalLinkageFields,
  isRootAgentJournalItem,
  namesAgentJournalProducer
} from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { foldCancellationTurn, retireCancellation } from './journal-stop-cancellation'
import { turnOpeningClientId } from './journal-cancellation-targets'
import { journalItemExecutionFence } from './journal-item-provenance'
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
    observeExecution(state, next)
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
  observeExecution(state, state.items.get(itemId)!)
}

function observeExecution(state: JournalReducerState, item: AgentJournalRenderItem): void {
  state.derivedTurnScope.cancellations.observeTurn(state, item)
  foldCancellationTurn(state, item.body, journalItemExecutionFence(state, item.itemId) ?? 0)
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
    const turn = readAgentJournalTurn(existing.body)
    const clientMessageId = turnOpeningClientId(state, turn?.userItemId ?? itemId)
    const turnId = turn?.turnId
    retireCancellation(state, turnId, clientMessageId)
    state.derivedTurnScope.cancellations.remove(turnId, clientMessageId)
    if (turnId !== undefined) {
      state.removedTurnIds.add(turnId)
    }
  }
  state.tombstones.set(itemId, revision)
  state.items.delete(itemId)
  state.itemFences.delete(itemId)
  state.itemExecutionOwners.delete(itemId)
}
