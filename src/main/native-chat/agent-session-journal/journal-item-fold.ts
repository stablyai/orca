import type { JournalOwnedItem } from './journal-execution-interruption'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  agentJournalLinkageFields,
  isRootAgentJournalItem,
  namesAgentJournalProducer
} from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
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
  next: JournalOwnedItem,
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
  const oldTurn = readAgentJournalTurn(existing?.body)
  const nextTurn = readAgentJournalTurn(next.body)
  if (
    oldTurn &&
    oldTurn.state !== 'running' &&
    oldTurn.state !== 'unverifiable' &&
    nextTurn?.turnId === oldTurn.turnId &&
    (nextTurn.state === 'running' || nextTurn.state === 'unverifiable') &&
    (fences.executionOwner === undefined ||
      fences.executionOwner === journalItemExecutionFence(state, itemId))
  ) {
    next = { ...next, body: existing!.body }
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
    ...(existing.executionInterruption
      ? { executionInterruption: existing.executionInterruption }
      : {}),
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

function observeExecution(state: JournalReducerState, item: JournalOwnedItem): void {
  state.derivedTurnScope.cancellations.observeTurn(state, item)
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
    const turnId = turn?.turnId
    const target =
      turnId === undefined ? undefined : state.derivedTurnScope.cancellations.turn(turnId)
    const clientMessageId =
      target?.clientMessageId ?? turnOpeningClientId(state, turn?.userItemId ?? itemId)
    const anchorId = target && state.derivedTurnScope.cancellations.anchor(target)
    const anchor = anchorId === undefined ? undefined : state.items.get(anchorId)
    if (turnId !== undefined && anchor?.executionInterruption) {
      const { executionInterruption: _removed, ...retained } = anchor
      state.items.set(anchor.itemId, retained)
    } else if (
      turnId === undefined &&
      existing.executionInterruption?.target.turnId !== undefined
    ) {
      const survivorId = state.derivedTurnScope.cancellations.turnItem(
        existing.executionInterruption.target.turnId
      )
      const survivor = survivorId === undefined ? undefined : state.items.get(survivorId)
      if (survivor && survivor.itemId !== itemId) {
        state.items.set(survivor.itemId, {
          ...survivor,
          executionInterruption: existing.executionInterruption
        })
      }
    }
    if (turnId !== undefined && clientMessageId !== undefined) {
      state.derivedTurnScope.cancellations.retireSubmission(state, clientMessageId)
    }
    state.derivedTurnScope.cancellations.remove(turnId, clientMessageId)
    if (turnId !== undefined) {
      state.removedTurnIds.add(turnId)
    }
  }
  state.tombstones.set(itemId, revision)
  state.items.delete(itemId)
  state.itemFences.delete(itemId)
  state.itemExecutionOwners.delete(itemId)
  const removedOpener = turnOpeningClientId(state, itemId)
  const survivingTurn =
    existing?.executionInterruption?.target.turnId ??
    (removedOpener === undefined
      ? undefined
      : state.derivedTurnScope.cancellations.openerTurn(removedOpener))
  const survivorId =
    survivingTurn === undefined
      ? undefined
      : state.derivedTurnScope.cancellations.turnItem(survivingTurn)
  const survivor = survivorId === undefined ? undefined : state.items.get(survivorId)
  if (survivor) {
    state.derivedTurnScope.cancellations.observeTurn(state, survivor)
  }
}
